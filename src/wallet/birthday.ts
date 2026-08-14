export const WALLET_BIRTHDAY_HEIGHT_KEY = "wallet_birthday_height";
export const WALLET_BIRTHDAY_PENDING = "pending";

type Kv = {
  keyValue: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
};

export type WalletBirthdayInspection =
  | { status: "none" }
  | { status: "pending" }
  | { status: "ok"; height: number };

export function markWalletBirthdayPending(db: Kv): void {
  db.keyValue.set(WALLET_BIRTHDAY_HEIGHT_KEY, WALLET_BIRTHDAY_PENDING);
}

export function inspectWalletBirthday(db: Kv): WalletBirthdayInspection {
  const raw = db.keyValue.get(WALLET_BIRTHDAY_HEIGHT_KEY);
  if (raw === null || !raw.trim()) return { status: "none" };
  const trimmed = raw.trim();
  if (trimmed === WALLET_BIRTHDAY_PENDING) return { status: "pending" };
  const height = Number.parseInt(trimmed, 10);
  // Corrupt values: behave like import (no floor), not stuck-pending.
  if (!Number.isFinite(height) || height < 0 || String(height) !== trimmed) {
    return { status: "none" };
  }
  return { status: "ok", height };
}

/** Compact-filter scan floor: birthday if set, otherwise the stored header min. */
export function compactFilterFrom(
  db: Kv & { headers: { minHeight(): number | null } },
): number | null {
  const minH = db.headers.minHeight();
  if (minH === null) return null;
  const birthday = inspectWalletBirthday(db);
  return birthday.status === "ok" ? Math.max(birthday.height, minH) : minH;
}

/** Freeze pending birthday to `height`. No-op if not pending. Returns whether written. */
export function maybeFreezeWalletBirthday(db: Kv, height: number): boolean {
  if (!Number.isInteger(height) || height < 0) return false;
  if (inspectWalletBirthday(db).status !== "pending") return false;
  db.keyValue.set(WALLET_BIRTHDAY_HEIGHT_KEY, String(height));
  return true;
}
