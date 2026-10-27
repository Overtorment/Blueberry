import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { bech32m, hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

const Point = secp256k1.ProjectivePoint;
const ORDER = secp256k1.CURVE.n;
export const SILENT_PAYMENT_MAX_OUTPUTS = 2323;
const { bytesToNumberBE, numberToBytesBE, taggedHash } = schnorr.utils;

function concat(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((n, v) => n + v.length, 0));
  let offset = 0;
  for (const value of values) { result.set(value, offset); offset += value.length; }
  return result;
}

function scalar(value: Uint8Array): bigint {
  const n = bytesToNumberBE(value);
  if (value.length !== 32 || n === 0n || n >= ORDER) {
    throw new Error("invalid Silent Payments scalar");
  }
  return n;
}

function publicPoint(value: Uint8Array) {
  if (value.length !== 33 || (value[0] !== 2 && value[0] !== 3)) {
    throw new Error("Silent Payments requires compressed public keys");
  }
  return Point.fromHex(value);
}

function u32(value: number, littleEndian = false): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("invalid unsigned 32-bit integer");
  }
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, littleEndian);
  return result;
}

export type SilentPaymentAddress = {
  version: number;
  scanPublicKey: Uint8Array;
  spendPublicKey: Uint8Array;
};

/** BIP352 v0 mainnet address. The 90-character SegWit limit does not apply. */
export function encodeSilentPaymentAddress(
  scanPublicKey: Uint8Array,
  spendPublicKey: Uint8Array,
): string {
  publicPoint(scanPublicKey);
  publicPoint(spendPublicKey);
  return bech32m.encode("sp", [0, ...bech32m.toWords(concat(scanPublicKey, spendPublicKey))], 1023);
}

export function decodeSilentPaymentAddress(address: string): SilentPaymentAddress {
  const decoded = bech32m.decode(address as `${string}1${string}`, 1023);
  if (decoded.prefix !== "sp") throw new Error("only mainnet Silent Payments addresses are supported");
  const version = decoded.words[0];
  if (version === undefined || version === 31) throw new Error("unsupported Silent Payments version");
  const data = bech32m.fromWords(decoded.words.slice(1));
  if ((version === 0 && data.length !== 66) || data.length < 66) {
    throw new Error("invalid Silent Payments address length");
  }
  const scanPublicKey = data.slice(0, 33);
  const spendPublicKey = data.slice(33, 66);
  publicPoint(scanPublicKey);
  publicPoint(spendPublicKey);
  return { version, scanPublicKey, spendPublicKey };
}

export function isSilentPaymentAddress(address: string): boolean {
  try { decodeSilentPaymentAddress(address); return true; } catch { return false; }
}

/** Derivation only: the current compact-filter sync does not receive SP funds. */
export function deriveSilentPaymentKeys(mnemonic: string, account = 0) {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(normalized, wordlist)) throw new Error("invalid BIP39 mnemonic");
  if (!Number.isInteger(account) || account < 0 || account >= 0x80000000) {
    throw new Error("invalid Silent Payments account");
  }
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(normalized));
  const scanPrivateKey = root.derive(`m/352'/0'/${account}'/1'/0`).privateKey!;
  const spendPrivateKey = root.derive(`m/352'/0'/${account}'/0'/0`).privateKey!;
  const scanPublicKey = secp256k1.getPublicKey(scanPrivateKey, true);
  const spendPublicKey = secp256k1.getPublicKey(spendPrivateKey, true);
  return { scanPrivateKey, spendPrivateKey, scanPublicKey, spendPublicKey,
    address: encodeSilentPaymentAddress(scanPublicKey, spendPublicKey) };
}

export type SilentPaymentOutpoint = { txid: string; vout: number };
export type SilentPaymentSenderInput = SilentPaymentOutpoint & {
  /** p2tr requires the tweaked OUTPUT private key, not the BIP32 internal key. */
  type: "p2wpkh" | "p2sh-p2wpkh" | "p2pkh" | "p2tr" | "other";
  privateKey?: Uint8Array;
};

function serializedOutpoints(inputs: SilentPaymentOutpoint[]): Uint8Array[] {
  if (inputs.length === 0) throw new Error("Silent Payments requires inputs");
  const seen = new Set<string>();
  return inputs.map(({ txid, vout }) => {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error("invalid input txid");
    const bytes = concat(hex.decode(txid).reverse(), u32(vout, true));
    const id = hex.encode(bytes);
    if (seen.has(id)) throw new Error("duplicate Silent Payments input");
    seen.add(id);
    return bytes;
  });
}

/** Hash commits to the byte-lexicographically smallest serialized outpoint. */
export function silentPaymentInputHash(
  inputs: SilentPaymentOutpoint[],
  inputPublicKeySum: Uint8Array,
): Uint8Array {
  publicPoint(inputPublicKeySum);
  const outpoints = serializedOutpoints(inputs);
  outpoints.sort((a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return 0;
  });
  const result = taggedHash("BIP0352/Inputs", outpoints[0]!, inputPublicKeySum);
  scalar(result);
  return result;
}

export type SilentPaymentOutput = {
  recipient: string;
  counter: number;
  /** X-only Taproot output key; do NOT apply an additional TapTweak. */
  publicKey: Uint8Array;
  scriptPubKey: Uint8Array;
  address: string;
};

function outputForPoint(point: InstanceType<typeof Point>) {
  if (point.equals(Point.ZERO)) throw new Error("Silent Payments output is point at infinity");
  const publicKey = point.toRawBytes(true).slice(1);
  return { publicKey, scriptPubKey: concat(Uint8Array.of(0x51, 0x20), publicKey),
    address: bech32m.encode("bc", [1, ...bech32m.toWords(publicKey)]) };
}

/** All transaction inputs must be frozen before deriving these outputs. */
export function deriveSilentPaymentOutputs(
  inputs: SilentPaymentSenderInput[],
  recipients: string[],
): SilentPaymentOutput[] {
  serializedOutpoints(inputs);
  let privateSum = 0n;
  let eligible = 0;
  for (const input of inputs) {
    if (input.type === "other") continue;
    if (!input.privateKey) throw new Error("Silent Payments requires every eligible input private key");
    let key = scalar(input.privateKey);
    if (input.type === "p2tr" && secp256k1.getPublicKey(input.privateKey, true)[0] === 3) {
      key = ORDER - key;
    }
    privateSum = (privateSum + key) % ORDER;
    eligible++;
  }
  if (!eligible || privateSum === 0n) throw new Error("Silent Payments input keys sum to zero");
  const inputSum = Point.BASE.multiply(privateSum).toRawBytes(true);
  const inputHash = scalar(silentPaymentInputHash(inputs, inputSum));
  const decoded = recipients.map((recipient) => ({ recipient, ...decodeSilentPaymentAddress(recipient) }));
  const counts = new Map<string, number>();
  for (const recipient of decoded) {
    const group = hex.encode(recipient.scanPublicKey);
    const count = (counts.get(group) ?? 0) + 1;
    if (count > SILENT_PAYMENT_MAX_OUTPUTS) throw new Error("too many Silent Payments outputs for one scan key");
    counts.set(group, count);
  }
  const counters = new Map<string, number>();
  return decoded.map(({ recipient, scanPublicKey, spendPublicKey }) => {
    const group = hex.encode(scanPublicKey);
    const counter = counters.get(group) ?? 0;
    counters.set(group, counter + 1);
    const sharedSecret = publicPoint(scanPublicKey).multiply((inputHash * privateSum) % ORDER).toRawBytes(true);
    const tweak = scalar(taggedHash("BIP0352/SharedSecret", sharedSecret, u32(counter)));
    const point = publicPoint(spendPublicKey).add(Point.BASE.multiply(tweak));
    return { recipient, counter, ...outputForPoint(point) };
  });
}

export function silentPaymentLabelTweak(scanPrivateKey: Uint8Array, label: number): Uint8Array {
  scalar(scanPrivateKey);
  const tweak = taggedHash("BIP0352/Label", scanPrivateKey, u32(label));
  scalar(tweak);
  return tweak;
}

export function encodeLabeledSilentPaymentAddress(
  scanPrivateKey: Uint8Array,
  spendPublicKey: Uint8Array,
  label: number,
): string {
  const tweak = scalar(silentPaymentLabelTweak(scanPrivateKey, label));
  const point = publicPoint(spendPublicKey).add(Point.BASE.multiply(tweak));
  if (point.equals(Point.ZERO)) throw new Error("invalid Silent Payments label");
  return encodeSilentPaymentAddress(secp256k1.getPublicKey(scanPrivateKey, true), point.toRawBytes(true));
}

export type SilentPaymentMatch = {
  outputIndex: number;
  counter: number;
  label?: number;
  publicKey: Uint8Array;
  /** Add to spend key modulo n; signing must normalize the final key to even Y. */
  privateKeyTweak: Uint8Array;
};

/**
 * Cryptographic scan only. Caller must extract ALL eligible input public keys
 * per BIP352 and reject transactions spending witness versions > 1. Public
 * keys of p2tr inputs must use their even-Y compressed output keys; skip NUMS
 * script-path inputs. All outpoints (including ineligible ones) must be passed.
 */
export function scanSilentPaymentOutputs(params: {
  inputs: SilentPaymentOutpoint[];
  inputPublicKeys: Uint8Array[];
  outputPublicKeys: Uint8Array[];
  scanPrivateKey: Uint8Array;
  spendPublicKey: Uint8Array;
  labels?: number[];
}): SilentPaymentMatch[] {
  const scan = scalar(params.scanPrivateKey);
  const spend = publicPoint(params.spendPublicKey);
  serializedOutpoints(params.inputs);
  let inputSum = Point.ZERO;
  for (const key of params.inputPublicKeys) inputSum = inputSum.add(publicPoint(key));
  if (inputSum.equals(Point.ZERO)) return [];
  const inputHash = scalar(silentPaymentInputHash(params.inputs, inputSum.toRawBytes(true)));
  const sharedSecret = inputSum.multiply((inputHash * scan) % ORDER).toRawBytes(true);
  const labels = [...new Set([0, ...(params.labels ?? [])])].map((label) => ({
    label, tweak: scalar(silentPaymentLabelTweak(params.scanPrivateKey, label)),
  }));
  const remaining = new Set(params.outputPublicKeys.map((key, i) => {
    if (key.length !== 32) throw new Error("Silent Payments outputs require x-only public keys");
    return i;
  }));
  const matches: SilentPaymentMatch[] = [];
  for (let counter = 0; counter < SILENT_PAYMENT_MAX_OUTPUTS && remaining.size; counter++) {
    const tweak = scalar(taggedHash("BIP0352/SharedSecret", sharedSecret, u32(counter)));
    const base = spend.add(Point.BASE.multiply(tweak));
    const candidates = [{ label: undefined as number | undefined, tweak, point: base },
      ...labels.map((label) => ({ label: label.label, tweak: (tweak + label.tweak) % ORDER,
        point: base.add(Point.BASE.multiply(label.tweak)) }))];
    let found = false;
    for (const candidate of candidates) {
      if (candidate.point.equals(Point.ZERO)) continue;
      const publicKey = candidate.point.toRawBytes(true).slice(1);
      for (const index of remaining) {
        if (hex.encode(params.outputPublicKeys[index]!) !== hex.encode(publicKey)) continue;
        matches.push({ outputIndex: index, counter, label: candidate.label, publicKey,
          privateKeyTweak: numberToBytesBE(candidate.tweak, 32) });
        remaining.delete(index);
        found = true;
        break;
      }
      if (found) break;
    }
    if (!found) break;
  }
  return matches;
}

export function silentPaymentSpendPrivateKey(
  spendPrivateKey: Uint8Array,
  privateKeyTweak: Uint8Array,
): Uint8Array {
  const sum = (scalar(spendPrivateKey) + bytesToNumberBE(privateKeyTweak)) % ORDER;
  if (privateKeyTweak.length !== 32 || bytesToNumberBE(privateKeyTweak) >= ORDER || sum === 0n) {
    throw new Error("invalid Silent Payments spending key");
  }
  const key = numberToBytesBE(sum, 32);
  return secp256k1.getPublicKey(key, true)[0] === 3 ? numberToBytesBE(ORDER - sum, 32) : key;
}
