import { gcm } from "@noble/ciphers/aes";
import { scrypt } from "@noble/hashes/scrypt";
import { hex } from "@scure/base";

/** On-disk prefix so boot can tell a blob from a plain secret. */
export const ENCRYPTED_SECRET_PREFIX = "bbenc1.";

const SCRYPT = {
  N: 1 << 15,
  r: 8,
  p: 1,
  dkLen: 32,
  maxmem: 128 * 1024 * 1024,
} as const;

const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

const utf8 = new TextEncoder();
const utf8dec = new TextDecoder();

function normalize(inp: string): string {
  return inp.normalize("NFC");
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function deriveKey(password: string, salt: Uint8Array): Uint8Array {
  return scrypt(normalize(password), salt, SCRYPT);
}

function isHex(value: string, bytes: number): boolean {
  return value.length === bytes * 2 && /^[0-9a-f]+$/i.test(value);
}

/** `bbenc1.<saltHex>:<ivHex>:<tagHex>:<cipherHex>` */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_SECRET_PREFIX);
}

export function isWellFormedEncryptedSecret(value: string): boolean {
  if (!isEncryptedSecret(value)) return false;
  const parts = value.slice(ENCRYPTED_SECRET_PREFIX.length).split(":");
  if (parts.length !== 4) return false;
  const [saltHex, ivHex, tagHex, cipherHex] = parts;
  if (!saltHex || !ivHex || !tagHex || !cipherHex) return false;
  if (!isHex(saltHex, SALT_LEN)) return false;
  if (!isHex(ivHex, IV_LEN)) return false;
  if (!isHex(tagHex, TAG_LEN)) return false;
  return (
    cipherHex.length >= 2 &&
    cipherHex.length % 2 === 0 &&
    /^[0-9a-f]+$/i.test(cipherHex)
  );
}

/**
 * AES-256-GCM (@noble/ciphers) + noble scrypt.
 * Envelope: Kraken-style `iv:tag:cipher` hex, plus a random salt.
 */
export async function encryptSecret(
  data: string,
  password: string,
): Promise<string> {
  if (!password) throw new Error("password is required");

  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(password, salt);
  const iv = randomBytes(IV_LEN);
  const sealed = gcm(key, iv).encrypt(utf8.encode(data));
  const ciphertext = sealed.subarray(0, sealed.length - TAG_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);

  return [
    `${ENCRYPTED_SECRET_PREFIX}${hex.encode(salt)}`,
    hex.encode(iv),
    hex.encode(tag),
    hex.encode(ciphertext),
  ].join(":");
}

export async function decryptSecret(
  data: string,
  password: string,
): Promise<string> {
  if (!password) throw new Error("password is required");
  if (!isWellFormedEncryptedSecret(data)) {
    throw new Error("invalid encrypted wallet_secret");
  }

  const [saltHex, ivHex, tagHex, encryptedHex] = data
    .slice(ENCRYPTED_SECRET_PREFIX.length)
    .split(":");
  const key = deriveKey(password, hex.decode(saltHex!));
  const ciphertext = hex.decode(encryptedHex!);
  const tag = hex.decode(tagHex!);
  const sealed = new Uint8Array(ciphertext.length + TAG_LEN);
  sealed.set(ciphertext);
  sealed.set(tag, ciphertext.length);

  try {
    const plain = gcm(key, hex.decode(ivHex!)).decrypt(sealed);
    return utf8dec.decode(plain);
  } catch {
    throw new Error("wrong password");
  }
}
