import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

describe("utxo_names", () => {
  test("get/upsert/delete/list by outpoint", () => {
    const db = createSqliteDatabase(":memory:");
    const out = `${"aa".repeat(32)}:0`;

    expect(db.utxoNames.get(out)).toBeNull();
    expect(db.utxoNames.list()).toEqual([]);

    db.utxoNames.upsert(out, "cold storage");
    expect(db.utxoNames.get(out)).toBe("cold storage");
    expect(db.utxoNames.list()).toEqual([
      { outpoint: out, name: "cold storage" },
    ]);

    db.utxoNames.upsert(out, "renamed");
    expect(db.utxoNames.get(out)).toBe("renamed");

    db.utxoNames.delete(out);
    expect(db.utxoNames.get(out)).toBeNull();
    expect(db.utxoNames.list()).toEqual([]);

    db.close();
  });
});
