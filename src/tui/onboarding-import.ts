import {
  decryptBip38ToWif,
  isBip38Key,
} from "../wallet/bip38.ts";
import { parseWalletSecret } from "../wallet/secret.ts";

export function classifyOnboardingSecret(
  raw: string,
):
  | { action: "bip38"; encrypted: string }
  | { action: "save"; secret: string } {
  const value = raw.trim();
  if (isBip38Key(value)) {
    return { action: "bip38", encrypted: value };
  }
  const parsed = parseWalletSecret(value);
  return { action: "save", secret: parsed.value };
}

export async function unlockBip38Secret(
  encrypted: string,
  password: string,
  scryptParams?: { N: number; r: number; p: number },
): Promise<string> {
  if (!password.trim()) {
    throw new Error("password is required");
  }
  const wif = await decryptBip38ToWif(encrypted, password, scryptParams);
  return parseWalletSecret(wif).value;
}

export function maskPassword(value: string): string {
  return "*".repeat(value.length);
}

export function nextPasswordFromMaskedInput(
  current: string,
  displayed: string,
): string {
  const stars = maskPassword(current);
  if (displayed.length < current.length) {
    return current.slice(0, displayed.length);
  }
  if (displayed.startsWith(stars)) {
    return current + displayed.slice(current.length);
  }
  return displayed;
}
