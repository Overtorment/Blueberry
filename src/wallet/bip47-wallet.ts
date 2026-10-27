import { p2pkh } from "@scure/btc-signer";
import { Transaction } from "bitcoinjs-lib";
import { config } from "../config.ts";
import { scriptHex } from "../parse/extract.ts";
import { deriveBip47Account, deriveBip47ReceivePayment, paymentCodeFromAccount } from "./bip47.ts";
import { createBip47Channels } from "./bip47-channels.ts";
import { discoverBip47Notification } from "./bip47-discovery.ts";
import { parseWalletSecret } from "./secret.ts";
import type { WatchWallet } from "./types.ts";

export const BIP47_ENABLED_KEY = "bip47_enabled_v1";
type Db = {
  keyValue: { get(key: string): string | null; set(key: string, value: string): void };
  transaction?(fn: () => void): void;
};

function transactional(db: Db) {
  return { keyValue: db.keyValue, transaction(fn: () => void) {
    if (!db.transaction) throw new Error("BIP47 requires transactional storage");
    db.transaction(fn);
  } };
}

/** BIP47 is opt-in: enabling queues a scan from the configured wallet birthday. */
export function appendBip47Watch(base: WatchWallet, db: Db): WatchWallet {
  if (db.keyValue.get(BIP47_ENABLED_KEY) !== "1" || parseWalletSecret(base.secret).kind !== "mnemonic") return base;
  const account = deriveBip47Account(base.secret);
  const notification = p2pkh(account.deriveChild(0).publicKey!);
  const channels = createBip47Channels(transactional(db), paymentCodeFromAccount(account));
  const addresses = [...base.addresses, {
    path: "bip47-notification", index: -1, change: false,
    address: notification.address!, scriptPubKey: notification.script, scriptType: "p2pkh" as const,
  }];
  for (const channel of channels.listIncoming()) {
    const count = Math.min(0x80000000, channel.usedThrough + 1 + config.gapLimit);
    for (let index = 0; index < count; index++) {
      const payment = deriveBip47ReceivePayment(account, channel.paymentCode, index);
      addresses.push({ path: `bip47/${channel.paymentCode}/${index}`, index, change: false,
        address: payment.address, scriptPubKey: payment.scriptPubKey, scriptType: "p2pkh" });
    }
  }
  return { ...base, addresses, scripts: addresses.map((address) => address.scriptPubKey) };
}

/** Incorporate confirmed notifications and advance incoming address windows. */
export function observeBip47Transactions(db: Db, wallet: WatchWallet, rows: { tx: Uint8Array }[]): boolean {
  if (rows.length === 0) return false;
  if (db.keyValue.get(BIP47_ENABLED_KEY) !== "1" || parseWalletSecret(wallet.secret).kind !== "mnemonic") return false;
  const account = deriveBip47Account(wallet.secret);
  const channels = createBip47Channels(transactional(db), paymentCodeFromAccount(account));
  const before = JSON.stringify(channels.listIncoming());
  const outgoing = channels.listOutgoing();
  const watched = new Map(wallet.addresses.filter((address) => address.path.startsWith("bip47/"))
    .map((address) => [scriptHex(address.scriptPubKey), address]));
  for (const row of rows) {
    const tx = Transaction.fromBuffer(Buffer.from(row.tx));
    const discovery = discoverBip47Notification(tx, account);
    if (discovery && discovery.senderPaymentCode !== paymentCodeFromAccount(account)) {
      channels.addIncoming(discovery.senderPaymentCode, discovery.txid);
    }
    for (const channel of outgoing) {
      if (channel.notificationTxid === tx.getId() && channel.notificationStatus !== "confirmed") {
        channels.confirmNotification(channel.paymentCode, tx.getId());
      }
    }
    for (const output of tx.outs) {
      const address = watched.get(scriptHex(output.script));
      if (!address) continue;
      const [, code] = address.path.split("/");
      channels.markIncomingUsed(code!, address.index);
    }
  }
  return before !== JSON.stringify(channels.listIncoming());
}
