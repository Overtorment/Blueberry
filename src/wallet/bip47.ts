import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256, sha512 } from "@noble/hashes/sha2";
import { concatBytes } from "@noble/hashes/utils";
import { base58check, hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { p2pkh } from "@scure/btc-signer";

const Point = secp256k1.ProjectivePoint;
const ORDER = secp256k1.CURVE.n;
const HARDENED = 0x80000000;
const check58 = base58check(sha256);

/** Version 1, Bitcoin mainnet, on-chain notifications (no Bitmessage). */
export type PaymentCode = {
  publicKey: Uint8Array;
  chainCode: Uint8Array;
};

export type Bip47Payment = {
  index: number;
  address: string;
  publicKey: Uint8Array;
  scriptPubKey: Uint8Array;
};

function checkIndex(index: number, name = "payment index"): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED) {
    throw new Error(`invalid BIP47 ${name}: expected a non-hardened index`);
  }
}

function checkPublicKey(publicKey: Uint8Array): void {
  if (publicKey.length !== 33 || (publicKey[0] !== 2 && publicKey[0] !== 3)) {
    throw new Error("invalid BIP47 compressed public key");
  }
  Point.fromHex(publicKey).assertValidity();
}

function checkPrivateKey(privateKey: Uint8Array): void {
  if (privateKey.length !== 32 || !secp256k1.utils.isValidPrivateKey(privateKey)) {
    throw new Error("invalid BIP47 private key");
  }
}

function checkPayloadMetadata(payload: Uint8Array): void {
  if (payload.length !== 80) throw new Error("BIP47 payload must be 80 bytes");
  if (payload[0] !== 1) throw new Error("only BIP47 version 1 is supported");
  if (payload[1] !== 0 || payload.slice(67).some((byte) => byte !== 0)) {
    throw new Error("unsupported BIP47 features or reserved bytes");
  }
  if (payload[2] !== 2 && payload[2] !== 3) {
    throw new Error("invalid BIP47 compressed public key prefix");
  }
}

/** Encode the 80-byte protocol payload, without the Base58Check prefix. */
export function paymentCodePayload(code: PaymentCode): Uint8Array {
  checkPublicKey(code.publicKey);
  if (code.chainCode.length !== 32) throw new Error("BIP47 chain code must be 32 bytes");
  const payload = new Uint8Array(80);
  payload[0] = 1;
  payload.set(code.publicKey, 2);
  payload.set(code.chainCode, 35);
  return payload;
}

export function encodePaymentCode(code: PaymentCode): string {
  return check58.encode(concatBytes(Uint8Array.of(0x47), paymentCodePayload(code)));
}

export function decodePaymentCode(value: string): PaymentCode {
  if (value.length > 120) throw new Error("invalid BIP47 payment code length");
  let decoded: Uint8Array;
  try {
    decoded = check58.decode(value);
  } catch {
    throw new Error("invalid BIP47 payment code checksum or encoding");
  }
  if (decoded.length !== 81 || decoded[0] !== 0x47) {
    throw new Error("invalid BIP47 payment code prefix or length");
  }
  const payload = decoded.slice(1);
  checkPayloadMetadata(payload);
  const publicKey = payload.slice(2, 35);
  checkPublicKey(publicKey);
  return { publicKey, chainCode: payload.slice(35, 67) };
}

export function isPaymentCode(value: string): boolean {
  try {
    decodePaymentCode(value);
    return true;
  } catch {
    return false;
  }
}

/** Derive m/47'/0'/account'. A zpub or WIF cannot recover this account. */
export function deriveBip47Account(mnemonic: string, account = 0): HDKey {
  checkIndex(account, "account index");
  const value = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(value, wordlist)) throw new Error("invalid BIP39 mnemonic");
  return HDKey.fromMasterSeed(mnemonicToSeedSync(value)).derive(`m/47'/0'/${account}'`);
}

function accountCode(account: HDKey): PaymentCode {
  if (account.depth !== 3 || account.index < HARDENED || !account.publicKey || !account.chainCode) {
    throw new Error("BIP47 requires an account-level HD key");
  }
  return { publicKey: account.publicKey, chainCode: account.chainCode };
}

export function paymentCodeFromAccount(account: HDKey): string {
  return encodePaymentCode(accountCode(account));
}

function publicAccount(code: string): HDKey {
  const decoded = decodePaymentCode(code);
  return new HDKey({ ...decoded, depth: 3, index: HARDENED });
}

function childAt(account: HDKey, index: number): HDKey {
  checkIndex(index);
  const child = account.deriveChild(index);
  // BIP32's invalid-child fallback must not silently change a persisted index.
  if (child.index !== index) throw new Error("invalid BIP47 child; increment the payment index");
  return child;
}

export function notificationPublicKey(paymentCode: string): Uint8Array {
  const key = childAt(publicAccount(paymentCode), 0).publicKey;
  if (!key) throw new Error("missing BIP47 notification public key");
  return key;
}

export function notificationAddress(paymentCode: string): string {
  return p2pkh(notificationPublicKey(paymentCode)).address!;
}

/** txid is the display-order transaction ID; the wire outpoint uses reversed bytes. */
export function serializeBip47Outpoint(txid: string, vout: number): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error("invalid BIP47 outpoint txid");
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) {
    throw new Error("invalid BIP47 outpoint index");
  }
  const outpoint = new Uint8Array(36);
  outpoint.set(hex.decode(txid).reverse());
  new DataView(outpoint.buffer).setUint32(32, vout, true);
  return outpoint;
}

function sharedX(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  checkPrivateKey(privateKey);
  checkPublicKey(publicKey);
  return secp256k1.getSharedSecret(privateKey, publicKey, true).slice(1);
}

/** Official vectors use the wire outpoint as HMAC key and ECDH x as the message. */
export function notificationBlindingMask(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  outpoint: Uint8Array,
): Uint8Array {
  if (outpoint.length !== 36) throw new Error("BIP47 outpoint must be 36 bytes");
  return hmac(sha512, outpoint, sharedX(privateKey, publicKey));
}

function xorPayload(payload: Uint8Array, mask: Uint8Array): Uint8Array {
  const result = payload.slice();
  for (let i = 0; i < 32; i++) {
    result[3 + i] = result[3 + i]! ^ mask[i]!;
    result[35 + i] = result[35 + i]! ^ mask[32 + i]!;
  }
  return result;
}

export function blindPaymentCode(params: {
  paymentCode: string;
  designatedPrivateKey: Uint8Array;
  recipientPaymentCode: string;
  outpoint: Uint8Array;
}): Uint8Array {
  const mask = notificationBlindingMask(
    params.designatedPrivateKey,
    notificationPublicKey(params.recipientPaymentCode),
    params.outpoint,
  );
  return xorPayload(paymentCodePayload(decodePaymentCode(params.paymentCode)), mask);
}

export function unblindPaymentCode(params: {
  payload: Uint8Array;
  recipientAccount: HDKey;
  designatedPublicKey: Uint8Array;
  outpoint: Uint8Array;
}): string {
  checkPayloadMetadata(params.payload);
  accountCode(params.recipientAccount);
  const privateKey = childAt(params.recipientAccount, 0).privateKey;
  if (!privateKey) throw new Error("BIP47 notification recovery requires a private account key");
  const mask = notificationBlindingMask(privateKey, params.designatedPublicKey, params.outpoint);
  const payload = xorPayload(params.payload, mask);
  // Blinding is unauthenticated. The caller must also validate transaction context.
  return encodePaymentCode({ publicKey: payload.slice(2, 35), chainCode: payload.slice(35, 67) });
}

function scalar(bytes: Uint8Array): bigint {
  const value = BigInt(`0x${hex.encode(bytes)}`);
  if (value === 0n || value >= ORDER) {
    throw new Error("invalid BIP47 shared scalar; increment the payment index");
  }
  return value;
}

function payment(publicKey: Uint8Array, index: number): Bip47Payment {
  const output = p2pkh(publicKey);
  return { index, address: output.address!, publicKey, scriptPubKey: output.script };
}

/** Requires an established notification channel and a durably reserved per-recipient index. */
export function deriveBip47SendPayment(
  senderAccount: HDKey,
  recipientPaymentCode: string,
  index: number,
): Bip47Payment {
  accountCode(senderAccount);
  const privateKey = childAt(senderAccount, 0).privateKey;
  if (!privateKey) throw new Error("BIP47 sending requires a private account key");
  const recipientPublicKey = childAt(publicAccount(recipientPaymentCode), index).publicKey!;
  const tweak = scalar(sha256(sharedX(privateKey, recipientPublicKey)));
  const destination = Point.fromHex(recipientPublicKey).add(Point.BASE.multiply(tweak));
  if (destination.equals(Point.ZERO)) {
    throw new Error("invalid BIP47 destination; increment the payment index");
  }
  return payment(destination.toRawBytes(true), index);
}

export function deriveBip47ReceivePayment(
  recipientAccount: HDKey,
  senderPaymentCode: string,
  index: number,
): Bip47Payment & { privateKey: Uint8Array } {
  accountCode(recipientAccount);
  const privateKey = childAt(recipientAccount, index).privateKey;
  if (!privateKey) throw new Error("BIP47 receiving requires a private account key");
  const tweak = scalar(sha256(sharedX(privateKey, notificationPublicKey(senderPaymentCode))));
  const destination = (scalar(privateKey) + tweak) % ORDER;
  if (destination === 0n) throw new Error("invalid BIP47 destination; increment the payment index");
  const destinationKey = hex.decode(destination.toString(16).padStart(64, "0"));
  return { ...payment(secp256k1.getPublicKey(destinationKey, true), index), privateKey: destinationKey };
}
