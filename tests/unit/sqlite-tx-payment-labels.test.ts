import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

describe("tx_payment_labels", () => {
  test("get/upsert/list by txid; replace keeps one row", () => {
    const db = createSqliteDatabase(":memory:");
    const txid = "aa".repeat(32);

    expect(db.txPaymentLabels.get(txid)).toBeNull();
    expect(db.txPaymentLabels.list()).toEqual([]);

    db.txPaymentLabels.upsert({ txid, label: "rent" });
    expect(db.txPaymentLabels.get(txid)).toEqual({ txid, label: "rent" });
    expect(db.txPaymentLabels.list()).toEqual([{ txid, label: "rent" }]);

    db.txPaymentLabels.upsert({ txid, label: "rent paid" });
    expect(db.txPaymentLabels.get(txid)).toEqual({
      txid,
      label: "rent paid",
    });
    expect(db.txPaymentLabels.list()).toHaveLength(1);

    db.close();
  });
});
