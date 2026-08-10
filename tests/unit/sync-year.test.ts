import { describe, expect, test } from "bun:test";
import { CHECKPOINTS } from "../../src/checkpoint.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  SYNC_FROM_YEAR_KEY,
  inspectSyncFromYear,
  latestCheckpointYear,
  listCheckpointYears,
  loadSyncFromYear,
  parseSyncFromYear,
  saveSyncFromYear,
} from "../../src/sync-year.ts";

describe("sync-year", () => {
  test("listCheckpointYears is sorted contiguous CHECKPOINTS keys", () => {
    const years = listCheckpointYears();
    expect(years[0]).toBe(2009);
    expect(years.at(-1)).toBe(2026);
    expect(latestCheckpointYear()).toBe(2026);
    expect(years).toHaveLength(Object.keys(CHECKPOINTS).length);
    for (let i = 1; i < years.length; i++) {
      expect(years[i]!).toBe(years[i - 1]! + 1);
    }
  });

  test("parseSyncFromYear accepts known years; rejects garbage", () => {
    expect(parseSyncFromYear("2019")).toBe(2019);
    expect(parseSyncFromYear(" 2015 ")).toBe(2015);
    expect(parseSyncFromYear(null)).toBeNull();
    expect(parseSyncFromYear("")).toBeNull();
    expect(parseSyncFromYear("1999")).toBeNull();
    expect(parseSyncFromYear("2019.0")).toBeNull();
    expect(parseSyncFromYear("019")).toBeNull();
    expect(parseSyncFromYear("abc")).toBeNull();
  });

  test("save/load round-trip; invalid KV reads as missing", () => {
    const db = createSqliteDatabase(":memory:");
    expect(inspectSyncFromYear(db).status).toBe("missing");
    expect(() => loadSyncFromYear(db)).toThrow(/sync_from_year/i);

    saveSyncFromYear(db, 2015);
    expect(db.keyValue.get(SYNC_FROM_YEAR_KEY)).toBe("2015");
    expect(loadSyncFromYear(db)).toBe(2015);

    db.keyValue.set(SYNC_FROM_YEAR_KEY, "nope");
    expect(inspectSyncFromYear(db).status).toBe("missing");
    expect(() => saveSyncFromYear(db, 1999)).toThrow(/unknown/i);
    db.close();
  });
});
