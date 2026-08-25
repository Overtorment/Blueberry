import { describe, expect, test } from "bun:test";
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

describe("SqliteDatabase headers", () => {
  test("ensureCheckpoint seeds once and rejects mismatch", () => {
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    expect(db.headers.count()).toBe(1);
    expect(db.headers.tip()?.height).toBe(seed.height);
    expect(db.headers.tip()?.cumulativeWork).toBeGreaterThan(0n);
    db.headers.ensureCheckpoint(checkpointDbRecord()); // idempotent
    expect(db.headers.count()).toBe(1);
    expect(() =>
      db.headers.ensureCheckpoint({
        ...checkpointDbRecord(),
        hashInternalHex: "00".repeat(32),
      }),
    ).toThrow(/checkpoint mismatch:.*Delete :memory: /s);
    db.close();
  });

  test("append and replaceAfter preserve cumulative work", () => {
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    const base = db.headers.tip()!.cumulativeWork;
    db.headers.append([
      hdr(seed.height + 1, "a1", base + 1n),
      hdr(seed.height + 2, "a2", base + 2n),
    ]);
    expect(db.headers.count()).toBe(3);
    expect(db.headers.tip()?.height).toBe(seed.height + 2);
    expect(db.headers.tip()?.cumulativeWork).toBe(base + 2n);
    db.headers.replaceAfter(seed.height, [
      hdr(seed.height + 1, "b1", base + 10n),
      hdr(seed.height + 2, "b2", base + 20n),
      hdr(seed.height + 3, "b3", base + 30n),
    ]);
    expect(db.headers.count()).toBe(4);
    expect(db.headers.tip()?.hashInternalHex.endsWith("b3")).toBe(true);
    expect(db.headers.tip()?.cumulativeWork).toBe(base + 30n);
    expect(db.headers.loadFrom(seed.height + 1).map((h) => h.height)).toEqual([
      seed.height + 1,
      seed.height + 2,
      seed.height + 3,
    ]);
    expect(db.headers.heightForHashInternal(hdr(seed.height + 2, "b2", 0n).hashInternalHex)).toBe(
      seed.height + 2,
    );
    db.close();
  });
});
