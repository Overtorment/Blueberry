import { hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2pkh, p2wpkh, Transaction } from "@scure/btc-signer";
import type { SendInputUtxo } from "./build-send-tx.ts";
import {
  blindPaymentCode,
  decodePaymentCode,
  deriveBip47Account,
  encodePaymentCode,
  notificationAddress,
  notificationPublicKey,
  paymentCodeFromAccount,
  serializeBip47Outpoint,
} from "./bip47.ts";
import { parseWalletSecret } from "./secret.ts";
import type { WatchWallet } from "./types.ts";

const MAX_MONEY = 21_000_000n * 100_000_000n;
const NOTIFICATION_DUST = 546n;
const CHANGE_DUST = 294n;

export type BuildBip47NotificationParams = {
  secret: string;
  wallet: WatchWallet;
  utxos: SendInputUtxo[];
  recipientPaymentCode: string;
  feeRateSatPerVb: number;
  changeAddress: string;
  notificationValueSats?: bigint;
};

export type BuildBip47NotificationResult = {
  kind: "signed";
  txHex: string;
  txid: string;
  feeSats: bigint;
  vsize: number;
  changeSats: bigint;
  changeVouts: number[];
  recipientPaymentCode: string;
  senderPaymentCode: string;
  notificationAddress: string;
};

function compactSizeLength(value: number): number {
  return value < 0xfd ? 1 : value <= 0xffff ? 3 : 5;
}

/** Maximum-size compressed P2WPKH witnesses, including marker and flag. */
function upperVsize(inputs: number, change: boolean): number {
  const baseBytes = 8 + compactSizeLength(inputs) + inputs * 41 + 1 + 34 + 92 + (change ? 31 : 0);
  return Math.ceil((4 * baseBytes + 2 + inputs * 109) / 4);
}

/**
 * Build a v1 notification with a P2WPKH designated input whose pubkey is in its
 * witness. Receivers must support witness pubkeys for notification discovery.
 * The caller must persist the channel's prepared txid before broadcasting.
 */
export function buildBip47Notification(params: BuildBip47NotificationParams): BuildBip47NotificationResult {
  const parsed = parseWalletSecret(params.secret);
  if (parsed.kind !== "mnemonic" || params.wallet.kind !== "bip84") {
    throw new Error("BIP47 notifications require a mnemonic BIP84 wallet");
  }
  if (params.utxos.length === 0) throw new Error("no UTXOs selected for BIP47 notification");
  if (!Number.isFinite(params.feeRateSatPerVb) || params.feeRateSatPerVb <= 0) {
    throw new Error("fee rate must be positive");
  }
  const notificationValue = params.notificationValueSats ?? NOTIFICATION_DUST;
  if (notificationValue < NOTIFICATION_DUST || notificationValue > MAX_MONEY) {
    throw new Error("BIP47 notification value must be at least 546 sats and within Bitcoin supply");
  }
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(parsed.value));
  const inputKeys: Uint8Array[] = [];
  const seen = new Set<string>();
  let total = 0n;
  const inputs = params.utxos.map((utxo) => {
    serializeBip47Outpoint(utxo.txid, utxo.vout);
    const outpoint = `${utxo.txid.toLowerCase()}:${utxo.vout}`;
    if (seen.has(outpoint)) throw new Error("duplicate BIP47 notification input");
    seen.add(outpoint);
    if (utxo.valueSats <= 0n || utxo.valueSats > MAX_MONEY) throw new Error("invalid BIP47 input value");
    total += utxo.valueSats;
    const watched = params.wallet.addresses.find((address) => hex.encode(address.scriptPubKey) === hex.encode(utxo.scriptPubKey));
    if (!watched || (watched.scriptType ?? "p2wpkh") !== "p2wpkh" ||
      !/^m\/84'\/0'\/0'\/[01]\/\d+$/.test(watched.path)) {
      throw new Error("BIP47 notification input is not an owned BIP84 coin");
    }
    const child = root.derive(watched.path);
    if (!child.privateKey || !child.publicKey) throw new Error("missing BIP84 input key");
    const output = p2wpkh(child.publicKey);
    if (hex.encode(output.script) !== hex.encode(utxo.scriptPubKey)) {
      throw new Error("BIP47 notification input key does not match its script");
    }
    inputKeys.push(child.privateKey);
    return {
      txid: hex.decode(utxo.txid), index: utxo.vout, sequence: 0xfffffffd,
      witnessUtxo: { script: output.script, amount: utxo.valueSats },
    };
  });
  if (total > MAX_MONEY) throw new Error("BIP47 input sum exceeds Bitcoin supply");
  const changeWatch = params.wallet.addresses.find((address) => address.address.toLowerCase() === params.changeAddress.toLowerCase());
  if (!changeWatch || (changeWatch.scriptType ?? "p2wpkh") !== "p2wpkh" ||
    !/^m\/84'\/0'\/0'\/[01]\/\d+$/.test(changeWatch.path)) {
    throw new Error("change address is not controlled by this BIP84 wallet");
  }
  const changePublic = root.derive(changeWatch.path).publicKey;
  if (!changePublic || p2wpkh(changePublic).address !== changeWatch.address) {
    throw new Error("change address is not controlled by this BIP84 wallet");
  }
  const feeFor = (hasChange: boolean) => BigInt(Math.ceil(upperVsize(inputs.length, hasChange) * params.feeRateSatPerVb));
  const change = total - notificationValue - feeFor(true);
  const hasChange = change >= CHANGE_DUST;
  if (!hasChange && total < notificationValue + feeFor(false)) {
    throw new Error("insufficient funds for BIP47 notification and fee");
  }
  const recipientPaymentCode = encodePaymentCode(decodePaymentCode(params.recipientPaymentCode));
  const senderPaymentCode = paymentCodeFromAccount(deriveBip47Account(parsed.value));
  if (recipientPaymentCode === senderPaymentCode) throw new Error("BIP47 self-notification is unsupported; use a normal receive address");
  const payload = blindPaymentCode({
    paymentCode: senderPaymentCode, designatedPrivateKey: inputKeys[0]!, recipientPaymentCode,
    outpoint: serializeBip47Outpoint(params.utxos[0]!.txid, params.utxos[0]!.vout),
  });
  // OP_RETURN OP_PUSHDATA1 80 <80-byte payload>.
  const returnScript = new Uint8Array(83);
  returnScript.set([0x6a, 0x4c, 0x50]);
  returnScript.set(payload, 3);
  const tx = new Transaction({ version: 2, allowUnknownOutputs: true });
  for (const input of inputs) tx.addInput(input);
  tx.addOutput({ script: p2pkh(notificationPublicKey(recipientPaymentCode)).script, amount: notificationValue });
  tx.addOutput({ script: returnScript, amount: 0n });
  if (hasChange) tx.addOutputAddress(changeWatch.address, change);
  for (const key of new Map(inputKeys.map((key) => [hex.encode(key), key])).values()) tx.sign(key);
  tx.finalize();
  if (tx.fee < BigInt(Math.ceil(params.feeRateSatPerVb * tx.vsize))) {
    throw new Error("BIP47 notification fee estimate was insufficient");
  }
  return {
    kind: "signed", txHex: tx.hex, txid: tx.id, feeSats: tx.fee, vsize: tx.vsize,
    changeSats: hasChange ? change : 0n, changeVouts: hasChange ? [2] : [],
    recipientPaymentCode, senderPaymentCode, notificationAddress: notificationAddress(recipientPaymentCode),
  };
}
