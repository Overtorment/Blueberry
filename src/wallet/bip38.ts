import { base58check } from "@scure/base";
import { p2pkh } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bip38 = require("bip38") as {
  decryptAsync: (
    encrypted: string,
    password: string,
    progress?: (status: { percent: number }) => void,
    scryptParams?: { N: number; r: number; p: number },
  ) => Promise<{ privateKey: Uint8Array; compressed: boolean }>;
};

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function sha256x2(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

const wifB58 = base58check(sha256);

/**
 * BIP38's checksum: SHA256(SHA256(UTF8(legacy p2pkh address)))[0..4].
 * npm `bip38` verifies this for method 1 (non-EC) but NOT for method 2
 * (EC-multiply, `0x0143`) — a wrong password there silently returns a
 * different, wrong private key instead of throwing. Verify it ourselves.
 */
function addressHashFor(
  privateKey: Uint8Array,
  compressed: boolean,
): Uint8Array {
  const publicKey = secp256k1.getPublicKey(privateKey, compressed);
  const pay = p2pkh(publicKey);
  if (!pay.address) throw new Error("invalid password-protected WIF");
  return sha256x2(new TextEncoder().encode(pay.address)).subarray(0, 4);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function isBip38Key(value: string): boolean {
  const v = value.trim();
  if (/\s/.test(v)) return false;
  return v.startsWith("6P") && v.length === 58;
}

export function encodeWif(
  privateKey: Uint8Array,
  compressed: boolean,
): string {
  if (privateKey.length !== 32) throw new Error("invalid private key");
  const body = compressed
    ? Uint8Array.of(0x80, ...privateKey, 0x01)
    : Uint8Array.of(0x80, ...privateKey);
  return wifB58.encode(body);
}

export async function decryptBip38ToWif(
  encrypted: string,
  password: string,
  scryptParams?: { N: number; r: number; p: number },
): Promise<string> {
  const key = encrypted.trim();
  if (!isBip38Key(key)) {
    throw new Error("invalid password-protected WIF");
  }
  let decrypted: { privateKey: Uint8Array; compressed: boolean };
  try {
    decrypted = await bip38.decryptAsync(key, password, undefined, scryptParams);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAssert =
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "ERR_ASSERTION";
    // npm bip38's EC-mult path asserts the flag byte is well-formed before
    // it ever touches the password. That is corrupt/garbage input, not a
    // wrong password — only salt/checksum/passphrase failures mean that.
    if (isAssert && msg.startsWith("Invalid private key.")) {
      throw new Error("invalid password-protected WIF");
    }
    if (isAssert || /passphrase|password/i.test(msg)) {
      throw new Error("incorrect password");
    }
    throw new Error("invalid password-protected WIF");
  }

  const privateKey = new Uint8Array(decrypted.privateKey);
  const decoded = wifB58.decode(key);
  const expectedHash = decoded.subarray(3, 7);
  const actualHash = addressHashFor(privateKey, decrypted.compressed);
  if (!bytesEqual(expectedHash, actualHash)) {
    // npm bip38 only verifies this checksum for method 1 (non-EC); for
    // method 2 (EC-multiply) it happily returns a wrong key with no throw.
    throw new Error("incorrect password");
  }

  return encodeWif(privateKey, decrypted.compressed);
}
