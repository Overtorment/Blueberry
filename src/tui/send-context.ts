import type { Database } from "../db/types.ts";
import { usedWatchIndexes } from "../parse/used-indexes.ts";
import {
  buildSend,
  type BuildSendResult,
  type SendInputUtxo,
} from "../wallet/build-send-tx.ts";
import {
  firstUnusedInternalAddress,
  preferredWifReceiveAddress,
} from "../wallet/receive-address.ts";
import type { Wallet } from "../wallet/wallet.ts";
import { deriveBip47Account, deriveBip47SendPayment, isPaymentCode, paymentCodeFromAccount } from "../wallet/bip47.ts";
import { createBip47Channels } from "../wallet/bip47-channels.ts";
import { buildBip47Notification } from "../wallet/bip47-notification.ts";
import { BIP47_ENABLED_KEY } from "../wallet/bip47-wallet.ts";
import { compactFilterFrom } from "../wallet/birthday.ts";
import { parseWalletSecret } from "../wallet/secret.ts";
import type { MessageBus } from "../bus/types.ts";

export type SendBuildParams = {
  utxos: SendInputUtxo[];
  toAddress: string;
  amountSats: bigint | "max";
  feeRateSatPerVb: number;
};

type Ctx = { db: Database; wallet: Wallet; bus?: MessageBus };

let active: Ctx | null = null;

export function setActiveSendContext(db: Database, wallet: Wallet, bus?: MessageBus): void {
  active = { db, wallet, bus };
}

function attachNonWitnessUtxos(
  db: Database,
  utxos: SendInputUtxo[],
): SendInputUtxo[] {
  return utxos.map((u) => {
    if (u.nonWitnessUtxo) return u;
    const prev = db.transactions.get(u.txid);
    return prev ? { ...u, nonWitnessUtxo: prev.tx } : u;
  });
}

function notificationIsConfirmed(db: Database, txid: string): boolean {
  const row = db.transactions.get(txid);
  return row !== null && db.headers.get(row.height)?.hashInternalHex === row.blockHashInternalHex;
}

/**
 * Build a send using the active DB + wallet.
 * BIP84: change from first unused internal.
 * WIF: change = preferred receive address (earliest activity / native default).
 * Address: change = the sole watched address.
 * Mnemonic/WIF → signed tx; zpub/address → unsigned PSBT.
 */
export function buildActiveSendTx(params: SendBuildParams): BuildSendResult {
  if (!active) throw new Error("send context not initialized");
  const { db, wallet } = active;
  wallet.syncFromDb();
  const watch = wallet.snapshot();
  let changeAddress: string;
  if (params.amountSats === "max") {
    changeAddress = params.toAddress;
  } else if (watch.kind === "wif") {
    changeAddress = preferredWifReceiveAddress(
      watch,
      db.transactions.list(),
    ).address;
  } else if (watch.kind === "address") {
    const addr = watch.addresses[0];
    if (!addr) throw new Error("address wallet missing watched address");
    changeAddress = addr.address;
  } else {
    const used = usedWatchIndexes(
      db.transactions.list().map((t) => ({ tx: t.tx })),
      watch,
    );
    const change = firstUnusedInternalAddress(watch, used.internal);
    if (!change) throw new Error("no unused change address in watch window");
    changeAddress = change.address;
  }

  let destination = params.toAddress.trim();
  let bip47NotificationTxid: string | undefined;
  if (isPaymentCode(destination)) {
    if (parseWalletSecret(watch.secret).kind !== "mnemonic") throw new Error("BIP47 requires a mnemonic wallet");
    const account = deriveBip47Account(watch.secret);
    const ownCode = paymentCodeFromAccount(account);
    if (destination === ownCode) throw new Error("BIP47 self-payments are unsupported; use a normal receive address");
    const channels = createBip47Channels(db, ownCode);
    const channel = channels.getOutgoing(destination);
    if (!channel?.notificationTxid || !notificationIsConfirmed(db, channel.notificationTxid)) {
      if (channel?.notificationStatus === "confirmed") channels.revokeNotificationConfirmation(destination);
      throw new Error("BIP47: create a notification with Ctrl+N, then wait for its confirmation before sending");
    }
    channels.confirmNotification(destination, channel.notificationTxid);
    bip47NotificationTxid = channel.notificationTxid;
    // Reserve before signing/preview: cancellation consumes an index safely.
    const index = channels.reserveSendIndex(destination);
    destination = deriveBip47SendPayment(account, destination, index).address;
  }
  const result = buildSend({
    secret: watch.secret,
    wallet: watch,
    utxos: attachNonWitnessUtxos(db, params.utxos),
    toAddress: destination,
    amountSats: params.amountSats,
    feeRateSatPerVb: params.feeRateSatPerVb,
    changeAddress,
  });
  if (result.kind === "signed" && bip47NotificationTxid) {
    result.resolvedToAddress = destination;
    result.bip47NotificationTxid = bip47NotificationTxid;
  }
  return result;
}

/** Recheck at broadcast because a reorg can occur while the preview is open. */
export function validateActivePaymentBroadcast(preview: BuildSendResult): void {
  if (preview.kind !== "signed" || !preview.bip47NotificationTxid) return;
  if (!active || !notificationIsConfirmed(active.db, preview.bip47NotificationTxid)) {
    throw new Error("BIP47 notification is no longer confirmed; close the preview and wait for confirmation");
  }
}

function enableBip47(db: Database, wallet: Wallet): void {
  if (db.keyValue.get(BIP47_ENABLED_KEY) === "1") return;
  db.keyValue.set(BIP47_ENABLED_KEY, "1");
  wallet.refresh();
  const from = compactFilterFrom(db) ?? db.filters.minHeight() ?? db.transactions.minHeight();
  if (from !== null) {
    db.filters.markUnscannedFrom(from);
    db.parsedBlocks.clearFrom(from);
  }
  active?.bus?.emit("filters:progress", { at: Date.now(), downloaded: db.filters.count(), total: db.filters.count() });
}

/** Explicit receive action; enables notification watching before code sharing. */
export function activeBip47PaymentCode(): string | null {
  if (!active) return null;
  const { db, wallet } = active;
  const secret = wallet.snapshot().secret;
  if (parseWalletSecret(secret).kind !== "mnemonic") return null;
  enableBip47(db, wallet);
  return paymentCodeFromAccount(deriveBip47Account(secret));
}

export function buildActiveBip47Notification(params: SendBuildParams): BuildSendResult {
  if (!active) throw new Error("send context not initialized");
  const { db, wallet } = active;
  if (parseWalletSecret(wallet.snapshot().secret).kind !== "mnemonic") throw new Error("BIP47 requires a mnemonic wallet");
  enableBip47(db, wallet);
  const watch = wallet.snapshot();
  const used = usedWatchIndexes(db.transactions.list(), watch);
  const change = firstUnusedInternalAddress(watch, used.internal);
  if (!change) throw new Error("no unused change address in watch window");
  const result = buildBip47Notification({ secret: watch.secret, wallet: watch,
    utxos: attachNonWitnessUtxos(db, params.utxos), recipientPaymentCode: params.toAddress.trim(),
    feeRateSatPerVb: params.feeRateSatPerVb, changeAddress: change.address });
  createBip47Channels(db, result.senderPaymentCode).prepareNotification(result.recipientPaymentCode, result.txid);
  return { ...result, purpose: "bip47-notification", resolvedToAddress: result.notificationAddress };
}

export function pickUtxosByKeys<T extends { key: string }>(
  utxos: T[],
  keys: string[],
): { ok: true; selected: T[] } | { ok: false; error: string } {
  if (keys.length === 0) {
    return { ok: false, error: "no UTXOs selected" };
  }
  const selected = utxos.filter((u) => keys.includes(u.key));
  if (selected.length === 0) {
    return { ok: false, error: "no UTXOs selected" };
  }
  if (selected.length !== keys.length) {
    return { ok: false, error: "some selected UTXOs are no longer available" };
  }
  return { ok: true, selected };
}
