export const ENCRYPTED_SECRET_PREFIX = "bbenc1.";

function isHex(value: string, bytes: number): boolean {
  return value.length === bytes * 2 && /^[0-9a-f]+$/i.test(value);
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_SECRET_PREFIX);
}

export function isWellFormedEncryptedSecret(value: string): boolean {
  if (!isEncryptedSecret(value)) return false;
  const parts = value.slice(ENCRYPTED_SECRET_PREFIX.length).split(":");
  if (parts.length !== 4) return false;
  const [saltHex, ivHex, tagHex, cipherHex] = parts;
  if (!saltHex || !ivHex || !tagHex || !cipherHex) return false;
  return isHex(saltHex, 16) && isHex(ivHex, 12) && isHex(tagHex, 16) &&
    cipherHex.length >= 2 && cipherHex.length % 2 === 0 && /^[0-9a-f]+$/i.test(cipherHex);
}
