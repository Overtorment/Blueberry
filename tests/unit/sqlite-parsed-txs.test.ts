import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

describe("parsed blocks + transactions", () => {
  test("parse queue, idempotent mark, upsert replace, newest-first list", () => {
    const db = createSqliteDatabase(":memory:");
    db.blocks.insert({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
      block: new Uint8Array([0x11]),
    });
    db.blocks.insert({
      height: 11,
      blockHashInternalHex: "bb".repeat(32),
      block: new Uint8Array([0x22]),
    });
    db.blocks.insert({
      height: 12,
      blockHashInternalHex: "cc".repeat(32),
      block: new Uint8Array([0x33]),
    });

    expect(db.blocks.listNeedingParse(10).map((b) => b.height)).toEqual([
      10, 11, 12,
    ]);
    db.parsedBlocks.mark(11);
    db.parsedBlocks.mark(11);
    expect(db.parsedBlocks.count()).toBe(1);
    expect(db.blocks.listNeedingParse(10).map((b) => b.height)).toEqual([
      10, 12,
    ]);

    db.transactions.upsert({
      txid: "a".repeat(64),
      height: 12,
      txIndex: 1,
      blockHashInternalHex: "cc".repeat(32),
      tx: new Uint8Array([0xaa]),
      netDeltaSats: 100,
    });
    db.transactions.upsert({
      txid: "b".repeat(64),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "aa".repeat(32),
      tx: new Uint8Array([0xbb]),
      netDeltaSats: 50,
    });
    db.transactions.upsert({
      txid: "a".repeat(64),
      height: 12,
      txIndex: 1,
      blockHashInternalHex: "cc".repeat(32),
      tx: new Uint8Array([0xaa]),
      netDeltaSats: 999,
    });
    db.transactions.setNetDelta("a".repeat(64), 42);

    const list = db.transactions.list();
    expect(list.map((t) => [t.txid[0], t.netDeltaSats])).toEqual([
      ["a", 42],
      ["b", 50],
    ]);
    expect(db.transactions.fingerprint()).toEqual({
      count: 2,
      netDeltaSum: 92,
      newestTxid: "a".repeat(64),
    });
    expect(db.transactions.get("b".repeat(64))?.tx).toEqual(
      new Uint8Array([0xbb]),
    );
    expect(db.transactions.get("c".repeat(64))).toBeNull();

    db.close();
  });

  test("transaction fingerprint is empty on a fresh database", () => {
    const db = createSqliteDatabase(":memory:");
    expect(db.transactions.fingerprint()).toEqual({
      count: 0,
      netDeltaSum: 0,
      newestTxid: null,
    });
    db.close();
  });
});
