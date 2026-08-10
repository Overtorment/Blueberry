import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

describe("key_value + markUnscannedFrom", () => {
  test("get/set key_value; markUnscannedFrom re-queues from height", () => {
    const db = createSqliteDatabase(":memory:");

    expect(db.keyValue.get("watch_external")).toBeNull();
    db.keyValue.set("watch_external", "40");
    db.keyValue.set("watch_internal", "40");
    expect(db.keyValue.get("watch_external")).toBe("40");
    db.keyValue.set("watch_external", "60");
    expect(db.keyValue.get("watch_external")).toBe("60");

    for (let h = 1; h <= 5; h++) {
      db.filters.append([
        {
          height: h,
          blockHashInternalHex: "ab".repeat(32),
          filter: new Uint8Array([0x00]),
        },
      ]);
    }
    db.filters.markScanned([1, 2, 3, 4, 5]);
    expect(db.filters.countScanned()).toBe(5);

    db.filters.markUnscannedFrom(3);
    expect(db.filters.listNeedingMatch(10).map((f) => f.height)).toEqual([
      3, 4, 5,
    ]);
    expect(db.filters.countScanned()).toBe(2);

    db.filters.markUnscannedFrom(3); // idempotent
    expect(db.filters.listNeedingMatch(10)).toHaveLength(3);

    db.transactions.upsert({
      txid: "aa".repeat(32),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "bb".repeat(32),
      tx: new Uint8Array([0x00]),
      netDeltaSats: 1,
    });
    db.transactions.upsert({
      txid: "cc".repeat(32),
      height: 4,
      txIndex: 0,
      blockHashInternalHex: "bb".repeat(32),
      tx: new Uint8Array([0x00]),
      netDeltaSats: 1,
    });
    expect(db.transactions.minHeight()).toBe(4);

    db.close();
  });
});
