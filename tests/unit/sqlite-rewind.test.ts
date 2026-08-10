import { describe, expect, test } from "bun:test";
import { hexToBytes } from "bitcoin-headers";
import { checkpointDbRecord, checkpointSeedRecord } from "../../src/checkpoint.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

function hdr(height: number, suffix: string, cumulativeWork: bigint) {
  return {
    height,
    hashInternalHex: "i".repeat(64 - suffix.length) + suffix,
    header: new Uint8Array(80).fill(0xab),
    cumulativeWork,
  };
}

describe("SqliteDatabase chain rewind", () => {
  test("rewindAfter drops height-dependent rows above ancestor", () => {
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    const base = db.headers.tip()!.cumulativeWork;
    const h1 = seed.height + 1;
    const h2 = seed.height + 2;
    db.headers.append([
      hdr(h1, "a1", base + 1n),
      hdr(h2, "a2", base + 2n),
    ]);

    db.filterHeaders.append([
      { height: h1, header: hexToBytes("11".repeat(32)) },
      { height: h2, header: hexToBytes("22".repeat(32)) },
    ]);
    db.filters.append([
      {
        height: h1,
        blockHashInternalHex: "11".repeat(32),
        filter: new Uint8Array([1]),
      },
      {
        height: h2,
        blockHashInternalHex: "22".repeat(32),
        filter: new Uint8Array([2]),
      },
    ]);
    db.matchedBlocks.insert({
      height: h2,
      blockHashInternalHex: "22".repeat(32),
    });
    db.blocks.insert({
      height: h2,
      blockHashInternalHex: "22".repeat(32),
      block: new Uint8Array([9]),
    });
    db.parsedBlocks.mark(h2);
    db.transactions.upsert({
      txid: "aa".repeat(32),
      height: h2,
      txIndex: 0,
      blockHashInternalHex: "22".repeat(32),
      tx: new Uint8Array([7]),
      netDeltaSats: 1,
    });

    db.transaction(() => {
      db.rewindAfter(h1);
      db.headers.replaceAfter(h1, [hdr(h2, "b2", base + 20n)]);
    });

    expect(db.headers.tip()?.hashInternalHex.endsWith("b2")).toBe(true);
    expect(db.filterHeaders.get(h2)).toBeNull();
    expect(db.filters.get(h2)).toBeNull();
    expect(db.filters.get(h1)).not.toBeNull();
    expect(db.matchedBlocks.count()).toBe(0);
    expect(db.blocks.has(h2)).toBe(false);
    expect(db.parsedBlocks.has(h2)).toBe(false);
    expect(db.transactions.list()).toEqual([]);
    db.close();
  });
});
