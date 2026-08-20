import { base58check } from "@scure/base";
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

const wifB58 = base58check(sha256);

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
  try {
    const decrypted = await bip38.decryptAsync(
      key,
      password,
      undefined,
      scryptParams,
    );
    return encodeWif(
      new Uint8Array(decrypted.privateKey),
      decrypted.compressed,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAssert =
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "ERR_ASSERTION";
    if (isAssert || /passphrase|password/i.test(msg)) {
      throw new Error("incorrect password");
    }
    throw new Error("invalid password-protected WIF");
  }
}
