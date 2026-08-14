import { describe, expect, test } from "bun:test";
import { buildBasicFilter, hexToBytes } from "bip158";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  MATCH_CHUNK_SIZE,
  MATCH_FILTER_BATCH_SIZE,
  scanFiltersForMatches,
} from "../../src/match/scan.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function displayHash(internalHex: string): Uint8Array {
  const internal = hexToBytes(internalHex);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = internal[31 - i]!;
  return out;
}

function append(
  db: ReturnType<typeof createSqliteDatabase>,
  height: number,
  internalHex: string,
  elements: Uint8Array[],
) {
  db.filters.append([
    {
      height,
      blockHashInternalHex: internalHex,
      filter: buildBasicFilter({
        blockHashDisplay: displayHash(internalHex),
        elements,
      }),
    },
  ]);
}

describe("scanFiltersForMatches", () => {
  test("hit inserts matched block and marks scanned; miss only marks scanned", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    const hitHash = "11".repeat(32);
    const missHash = "22".repeat(32);
    append(db, 100, hitHash, [wallet.scripts[0]!]);
    append(db, 101, missHash, [
      new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]),
    ]);
    const matches: number[] = [];
    const advanced = await scanFiltersForMatches(
      db,
      wallet.scripts,
      { onMatch: (m) => matches.push(m.height) },
      { yieldFn: async () => {}, batchGapMs: 0, chunkSize: 1000 },
    );
    expect(advanced).toBe(2);
    expect(matches).toEqual([100]);
    expect(db.matchedBlocks.count()).toBe(1);
    expect(db.filters.countScanned()).toBe(2);
    expect(db.filters.listNeedingMatch(10)).toEqual([]);
    db.close();
  });

  test("skips already scanned rows", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    append(db, 200, "33".repeat(32), [wallet.scripts[0]!]);
    db.filters.markScanned([200]);
    const matches: number[] = [];
    const advanced = await scanFiltersForMatches(
      db,
      wallet.scripts,
      { onMatch: (m) => matches.push(m.height) },
      { yieldFn: async () => {}, batchGapMs: 0, chunkSize: 1000 },
    );
    expect(advanced).toBe(0);
    expect(matches).toEqual([]);
    expect(db.matchedBlocks.count()).toBe(0);
    db.close();
  });

  test("refreshes total when filters are appended mid-scan", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    const junk = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]);
    append(db, 1, "01".repeat(32), [junk]);
    append(db, 2, "02".repeat(32), [junk]);

    const progressTotals: number[] = [];
    let appended = false;
    await scanFiltersForMatches(
      db,
      wallet.scripts,
      { onProgress: (p) => progressTotals.push(p.total) },
      {
        batchGapMs: 0,
        chunkSize: 1,
        yieldFn: async () => {
          if (!appended) {
            appended = true;
            append(db, 3, "03".repeat(32), [junk]);
          }
        },
      },
    );

    expect(progressTotals.some((t) => t >= 3)).toBe(true);
    expect(progressTotals.at(-1)).toBe(3);
    db.close();
  });

  test("does not re-emit match for existing matched_blocks row", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    const hash = "44".repeat(32);
    append(db, 300, hash, [wallet.scripts[0]!]);
    db.matchedBlocks.insert({ height: 300, blockHashInternalHex: hash });
    const matches: number[] = [];
    await scanFiltersForMatches(
      db,
      wallet.scripts,
      { onMatch: (m) => matches.push(m.height) },
      { yieldFn: async () => {}, batchGapMs: 0, chunkSize: 1000 },
    );
    expect(matches).toEqual([]);
    expect(db.filters.listNeedingMatch(10)).toEqual([]);
    db.close();
  });

  test("progress scanned tracks countScanned after mid-scan re-queue", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    const junk = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]);
    for (let h = 1; h <= 6; h++) {
      append(db, h, h.toString(16).padStart(2, "0").repeat(32), [junk]);
    }

    const progress: Array<{ scanned: number; total: number }> = [];
    let requeued = false;
    await scanFiltersForMatches(
      db,
      wallet.scripts,
      { onProgress: (p) => progress.push({ ...p }) },
      {
        batchGapMs: 0,
        chunkSize: 2,
        batchSize: 2,
        yieldFn: async () => {
          if (!requeued && db.filters.countScanned() >= 2) {
            requeued = true;
            // Gap-growth style rematch: put already-scanned heights back.
            db.filters.markUnscannedFrom(1);
          }
        },
      },
    );

    for (const p of progress) {
      expect(p.scanned).toBeLessThanOrEqual(p.total);
    }
    expect(progress.at(-1)).toEqual({ scanned: 6, total: 6 });
    db.close();
  });

  test("default chunk is smaller than the DB batch so matching can yield", () => {
    expect(MATCH_CHUNK_SIZE).toBeLessThan(MATCH_FILTER_BATCH_SIZE);
  });

  test("drops a stale in-memory chunk after rewind so the new hash can match", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    const oldHash = "11".repeat(32);
    const newHash = "aa".repeat(32);
    append(db, 100, oldHash, [wallet.scripts[0]!]);
    append(db, 101, oldHash, [wallet.scripts[0]!]);

    let rewound = false;
    await scanFiltersForMatches(
      db,
      wallet.scripts,
      {},
      {
        yieldFn: async () => {
          if (!rewound && db.filters.countScanned() >= 1) {
            rewound = true;
            db.rewindAfter(100);
            append(db, 101, newHash, [wallet.scripts[0]!]);
          }
        },
        batchGapMs: 0,
        chunkSize: 1,
      },
    );

    expect(db.matchedBlocks.get(100)?.blockHashInternalHex).toBe(oldHash);
    expect(db.matchedBlocks.get(101)?.blockHashInternalHex).toBe(newHash);
    expect(db.filters.listNeedingMatch(10)).toEqual([]);
    db.close();
  });
});
