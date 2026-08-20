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

/**
 * Reconstructs the real password from a masked text input's raw value.
 *
 * The widget only ever sees `displayed` (a mix of stars for untouched chars
 * and literal chars where the user just typed); it carries no cursor
 * position. Only two edit shapes can be reconstructed unambiguously:
 *   - append: `displayed` extends the current mask with new literal chars.
 *   - end-backspace: `displayed` is a shorter, all-star prefix of the mask.
 * Any other shape (insert before/middle, delete from the front, paste over
 * a selection, …) is treated as a full replace of the visible edit, with
 * leftover `*` from the old mask stripped so they never leak into the
 * stored password.
 */
export function nextPasswordFromMaskedInput(
  current: string,
  displayed: string,
): string {
  const stars = maskPassword(current);
  if (displayed.length > current.length && displayed.startsWith(stars)) {
    return current + displayed.slice(current.length);
  }
  if (
    displayed.length <= current.length &&
    displayed === stars.slice(0, displayed.length)
  ) {
    return current.slice(0, displayed.length);
  }
  return displayed.replace(/\*/g, "");
}
