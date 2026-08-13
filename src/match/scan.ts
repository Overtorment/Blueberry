import { matchAnyBasicFilters } from "bip158";
import type { Database } from "../db/types.ts";

/** Rows loaded from SQLite per outer iteration. */
export const MATCH_FILTER_BATCH_SIZE = 1000;

/**
 * Sync match slice before yielding to the event loop.
 * Smaller than the DB batch — matchAnyBasicFilters is a per-filter JS loop.
 */
export const MATCH_CHUNK_SIZE = 50;

/** Extra sleep after each chunk; 0 = setTimeout(0) yield only (tests pass 0). */
export const MATCH_BATCH_GAP_MS = 0;

export type MatchScanCallbacks = {
  onMatch?: (m: { height: number; blockHashInternalHex: string }) => void;
  onProgress?: (p: { scanned: number; total: number }) => void;
};

export type MatchScanOptions = {
  batchSize?: number;
  chunkSize?: number;
  yieldFn?: () => Promise<void>;
  batchGapMs?: number;
  shouldContinue?: () => boolean;
};

function defaultYield(): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 0);
    t.unref?.();
  });
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function toDisplayHash(internalHex: string): Uint8Array {
  const internal = Buffer.from(internalHex, "hex");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = internal[31 - i]!;
  return out;
}

/** Scan unscanned filters until empty or shouldContinue is false. */
export async function scanFiltersForMatches(
  db: Database,
  scripts: Uint8Array[],
  callbacks?: MatchScanCallbacks,
  options?: MatchScanOptions,
): Promise<number> {
  const batchSize = Math.max(1, options?.batchSize ?? MATCH_FILTER_BATCH_SIZE);
  const chunkSize = Math.max(1, options?.chunkSize ?? MATCH_CHUNK_SIZE);
  const yieldFn = options?.yieldFn ?? defaultYield;
  const batchGapMs = Math.max(0, options?.batchGapMs ?? MATCH_BATCH_GAP_MS);
  const shouldContinue = options?.shouldContinue;

  let total = db.filters.count();
  let scanned = db.filters.countScanned();
  let advanced = 0;

  const emitProgress = () => {
    total = db.filters.count();
    callbacks?.onProgress?.({ scanned, total });
  };

  const pause = async () => {
    if (batchGapMs > 0) await sleep(batchGapMs);
    else await yieldFn();
  };

  emitProgress();
  await pause();

  while (shouldContinue?.() !== false) {
    const batch = db.filters.listNeedingMatch(batchSize);
    if (batch.length === 0) {
      emitProgress();
      return advanced;
    }

    for (let offset = 0; offset < batch.length; offset += chunkSize) {
      if (shouldContinue?.() === false) {
        emitProgress();
        return advanced;
      }

      const chunk = batch.slice(offset, offset + chunkSize);
      const filterBytesList = chunk.map((row) => row.filter);
      const hashList = chunk.map((row) =>
        toDisplayHash(row.blockHashInternalHex),
      );

      const hitFlags = matchAnyBasicFilters(
        filterBytesList,
        hashList,
        scripts,
      );

      const heights: number[] = [];
      for (let i = 0; i < chunk.length; i++) {
        const row = chunk[i]!;
        heights.push(row.height);
        if (hitFlags[i]) {
          const inserted = db.matchedBlocks.insert({
            height: row.height,
            blockHashInternalHex: row.blockHashInternalHex,
          });
          if (inserted) {
            callbacks?.onMatch?.({
              height: row.height,
              blockHashInternalHex: row.blockHashInternalHex,
            });
          }
        }
        advanced++;
      }

      db.filters.markScanned(heights);
      // Re-read: markUnscannedFrom (gap growth) can re-queue mid-scan; a
      // monotonic scanned++ would then report scanned > total.
      scanned = db.filters.countScanned();
      emitProgress();
      await pause();
    }
  }

  return advanced;
}
