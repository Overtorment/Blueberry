import {
  deriveWatchWallet,
  type WatchGaps,
} from "./derive.ts";
import { loadWalletSecret, parseWalletSecret } from "./secret.ts";
import type { WatchWallet } from "./types.ts";
import { loadWatchGaps, saveWatchGaps } from "./watch-gaps.ts";

type KvDb = {
  keyValue: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
};

export type CreateWalletOptions = {
  /** Test override; otherwise load + validate `wallet_secret` from KV. */
  secret?: string;
  /** If set, write both watch gaps to this count before first derive. */
  addressGap?: number;
};

export type Wallet = {
  snapshot(): WatchWallet;
  scripts(): Uint8Array[];
  /** Gaps used for the current in-memory derive. */
  gaps(): WatchGaps;
  /** Read watch gaps from DB without re-deriving. */
  peekGaps(): WatchGaps;
  /** Re-read gaps from DB and re-derive. */
  refresh(): WatchWallet;
  /**
   * Re-read gaps from DB; re-derive only when gaps changed.
   * Returns whether a re-derive happened because gaps grew/changed.
   */
  syncFromDb(): { grew: boolean };
};

export function createWallet(
  db: KvDb,
  options: CreateWalletOptions = {},
): Wallet {
  const raw = options.secret ?? loadWalletSecret(db);
  const secret = parseWalletSecret(raw).value;

  if (options.addressGap !== undefined) {
    const n = Math.max(0, Math.floor(options.addressGap));
    saveWatchGaps(db, { external: n, internal: n });
  }

  let currentGaps = loadWatchGaps(db);
  let current = deriveWatchWallet(secret, currentGaps);

  return {
    snapshot: () => current,
    scripts: () => current.scripts,
    gaps: () => currentGaps,
    peekGaps: () => loadWatchGaps(db),
    refresh: () => {
      currentGaps = loadWatchGaps(db);
      current = deriveWatchWallet(secret, currentGaps);
      return current;
    },
    syncFromDb: () => {
      const gaps = loadWatchGaps(db);
      const grew =
        gaps.external !== currentGaps.external ||
        gaps.internal !== currentGaps.internal;
      if (grew) {
        currentGaps = gaps;
        current = deriveWatchWallet(secret, currentGaps);
      }
      return { grew };
    },
  };
}
