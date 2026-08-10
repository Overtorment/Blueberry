import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { hexToBytes } from "bitcoin-headers";
import { checkpointDbRecord, checkpointSeedRecord } from "../../src/checkpoint.ts";
import { ensureSchema } from "../../src/db/schema.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

describe("SqliteDatabase filters", () => {
  test("schema creates a covering filter metadata index", () => {
    const raw = new BunDatabase(":memory:");
    ensureSchema(raw);
    const columns = raw
      .query("PRAGMA index_info('filters_height_hash')")
      .all() as Array<{ seqno: number; name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      "height",
      "block_hash_internal_hex",
    ]);
    raw.close();
  });

  test("filters.filter round-trips as blob bytes", () => {
    const db = createSqliteDatabase(":memory:");
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    db.filters.append([
      {
        height: 1,
        blockHashInternalHex: "11".repeat(32),
        filter: bytes,
      },
    ]);
    expect(db.filters.get(1)!.filter).toEqual(bytes);
    db.close();
  });

  test("headers.minHeight returns lowest stored height", () => {
    const db = createSqliteDatabase(":memory:");
    expect(db.headers.minHeight()).toBeNull();
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    expect(db.headers.minHeight()).toBe(seed.height);
    db.close();
  });

  test("filter headers append/get/deleteFrom", () => {
    const db = createSqliteDatabase(":memory:");
    db.filterHeaders.append([
      { height: 10, header: hexToBytes("aa".repeat(32)) },
      { height: 11, header: hexToBytes("bb".repeat(32)) },
    ]);
    expect(db.filterHeaders.get(10)?.header).toEqual(hexToBytes("aa".repeat(32)));
    expect(db.filterHeaders.tip()?.height).toBe(11);
    expect(db.filterHeaders.loadRange(10, 11).map((r) => r.height)).toEqual([
      10, 11,
    ]);
    db.filterHeaders.deleteFrom(11);
    expect(db.filterHeaders.tip()?.height).toBe(10);
    db.close();
  });

  test("filters missingRanges splits gaps by maxSpan", () => {
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 100,
        blockHashInternalHex: "11".repeat(32),
        filter: new Uint8Array([0x01]),
      },
      {
        height: 103,
        blockHashInternalHex: "33".repeat(32),
        filter: new Uint8Array([0x03]),
      },
    ]);
    expect(db.filters.missingRanges(100, 104, 2)).toEqual([
      { from: 101, to: 102 },
      { from: 104, to: 104 },
    ]);
    db.filters.append([
      {
        height: 101,
        blockHashInternalHex: "12".repeat(32),
        filter: new Uint8Array([0x02]),
      },
      {
        height: 102,
        blockHashInternalHex: "13".repeat(32),
        filter: new Uint8Array([0x04]),
      },
      {
        height: 104,
        blockHashInternalHex: "14".repeat(32),
        filter: new Uint8Array([0x05]),
      },
    ]);
    expect(db.filters.missingRanges(100, 104, 2)).toEqual([]);
    expect(db.filters.countInRange(100, 104)).toBe(5);
    expect(db.filters.maxHeight()).toBe(104);
    db.filters.deleteFrom(103);
    expect(db.filters.has(103)).toBe(false);
    expect(db.filters.maxHeight()).toBe(102);
    db.close();
  });

  test("filters missingRanges tip gap uses contiguous fast path", () => {
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 100,
        blockHashInternalHex: "11".repeat(32),
        filter: new Uint8Array([0x01]),
      },
      {
        height: 101,
        blockHashInternalHex: "22".repeat(32),
        filter: new Uint8Array([0x02]),
      },
      {
        height: 102,
        blockHashInternalHex: "33".repeat(32),
        filter: new Uint8Array([0x03]),
      },
    ]);
    // Contiguous through 102; tip advanced to 105 — only the tip gap.
    expect(db.filters.missingRanges(100, 105, 2)).toEqual([
      { from: 103, to: 104 },
      { from: 105, to: 105 },
    ]);
    db.close();
  });

  test("filters missingRanges walks present heights (leading/trailing gaps)", () => {
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 105,
        blockHashInternalHex: "55".repeat(32),
        filter: new Uint8Array([0x05]),
      },
      {
        height: 107,
        blockHashInternalHex: "77".repeat(32),
        filter: new Uint8Array([0x07]),
      },
    ]);
    expect(db.filters.missingRanges(100, 110, 3)).toEqual([
      { from: 100, to: 102 },
      { from: 103, to: 104 },
      { from: 106, to: 106 },
      { from: 108, to: 110 },
    ]);
    db.close();
  });

  test("filters completeInRange detects tip gap and internal holes", () => {
    const db = createSqliteDatabase(":memory:");
    expect(db.filters.completeInRange(100, 102)).toBe(false);
    db.filters.append([
      {
        height: 100,
        blockHashInternalHex: "11".repeat(32),
        filter: new Uint8Array([0x01]),
      },
      {
        height: 101,
        blockHashInternalHex: "22".repeat(32),
        filter: new Uint8Array([0x02]),
      },
      {
        height: 102,
        blockHashInternalHex: "33".repeat(32),
        filter: new Uint8Array([0x03]),
      },
    ]);
    expect(db.filters.completeInRange(100, 102)).toBe(true);
    expect(db.filters.completeInRange(100, 103)).toBe(false); // tip gap
    db.filters.deleteFrom(101);
    db.filters.append([
      {
        height: 102,
        blockHashInternalHex: "33".repeat(32),
        filter: new Uint8Array([0x03]),
      },
    ]);
    expect(db.filters.completeInRange(100, 102)).toBe(false); // hole at 101
    db.close();
  });

  test("firstHashMismatch finds disagreeing filter", () => {
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    const from = seed.height;
    expect(db.filters.firstHashMismatch(from, from)).toBeNull();

    db.filters.append([
      {
        height: from,
        blockHashInternalHex: "ff".repeat(32),
        filter: new Uint8Array([0x02]),
      },
    ]);
    expect(db.filters.firstHashMismatch(from, from)).toBe(from);
    db.close();
  });

  test("listNeedingMatch, markScanned, countScanned", () => {
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 10,
        blockHashInternalHex: "aa".repeat(32),
        filter: new Uint8Array([0x01]),
      },
      {
        height: 11,
        blockHashInternalHex: "bb".repeat(32),
        filter: new Uint8Array([0x02]),
      },
      {
        height: 12,
        blockHashInternalHex: "cc".repeat(32),
        filter: new Uint8Array([0x03]),
      },
    ]);
    expect(db.filters.countScanned()).toBe(0);
    expect(db.filters.listNeedingMatch(10).map((r) => r.height)).toEqual([
      10, 11, 12,
    ]);
    expect(db.filters.listNeedingMatch(1).map((r) => r.height)).toEqual([10]);

    db.filters.markScanned([10, 12]);
    expect(db.filters.countScanned()).toBe(2);
    expect(db.filters.listNeedingMatch(10).map((r) => r.height)).toEqual([11]);

    db.filters.markScanned([11]);
    expect(db.filters.listNeedingMatch(10)).toEqual([]);
    expect(db.filters.countScanned()).toBe(3);
    db.close();
  });

  test("markScanned uses filters_unscanned queue (not fat-row updates)", () => {
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 1,
        blockHashInternalHex: "aa".repeat(32),
        filter: new Uint8Array(1000).fill(0x01),
      },
      {
        height: 2,
        blockHashInternalHex: "bb".repeat(32),
        filter: new Uint8Array(1000).fill(0x02),
      },
    ]);
    db.filters.markScanned([2]);
    expect(db.filters.countScanned()).toBe(1);
    expect(db.filters.listNeedingMatch(10).map((r) => r.height)).toEqual([1]);
    db.filters.markScanned([1]);
    expect(db.filters.listNeedingMatch(10)).toEqual([]);
    expect(db.filters.countScanned()).toBe(2);
    db.close();
  });

  test("matched_blocks insert is idempotent", () => {
    const db = createSqliteDatabase(":memory:");
    expect(
      db.matchedBlocks.insert({
        height: 10,
        blockHashInternalHex: "aa".repeat(32),
      }),
    ).toBe(true);
    expect(
      db.matchedBlocks.insert({
        height: 10,
        blockHashInternalHex: "bb".repeat(32),
      }),
    ).toBe(false);
    expect(db.matchedBlocks.count()).toBe(1);
    db.close();
  });

  test("blocks insert/count/has and listNeedingDownload", () => {
    const db = createSqliteDatabase(":memory:");
    db.matchedBlocks.insert({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
    });
    db.matchedBlocks.insert({
      height: 11,
      blockHashInternalHex: "bb".repeat(32),
    });
    db.matchedBlocks.insert({
      height: 12,
      blockHashInternalHex: "cc".repeat(32),
    });

    expect(db.matchedBlocks.listNeedingDownload(10).map((r) => r.height)).toEqual([
      10, 11, 12,
    ]);
    expect(db.blocks.count()).toBe(0);
    expect(db.blocks.has(10)).toBe(false);

    expect(
      db.blocks.insert({
        height: 10,
        blockHashInternalHex: "aa".repeat(32),
        block: new Uint8Array(8).fill(0xdd),
      }),
    ).toBe(true);
    expect(
      db.blocks.insert({
        height: 10,
        blockHashInternalHex: "aa".repeat(32),
        block: new Uint8Array(8).fill(0xee),
      }),
    ).toBe(false);

    expect(db.blocks.count()).toBe(1);
    expect(db.blocks.has(10)).toBe(true);
    expect(db.blocks.get(10)).toMatchObject({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
      block: new Uint8Array(8).fill(0xdd),
    });
    expect(db.matchedBlocks.listNeedingDownload(10).map((r) => r.height)).toEqual([
      11, 12,
    ]);
    expect(db.matchedBlocks.listNeedingDownload(1).map((r) => r.height)).toEqual([
      11,
    ]);
    db.close();
  });
});
