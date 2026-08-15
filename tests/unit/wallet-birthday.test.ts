import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { openTempFileLog } from "./file-log-harness.ts";
import {
  WALLET_BIRTHDAY_HEIGHT_KEY,
  compactFilterFrom,
  inspectWalletBirthday,
  markWalletBirthdayPending,
  maybeFreezeWalletBirthday,
} from "../../src/wallet/birthday.ts";

describe("wallet birthday", () => {
  test("none → pending → freeze once; ignore later tips; garbage → none", () => {
    const file = openTempFileLog();
    const db = createSqliteDatabase(":memory:");
    expect(inspectWalletBirthday(db)).toEqual({ status: "none" });
    expect(maybeFreezeWalletBirthday(db, 100)).toBe(false);

    markWalletBirthdayPending(db);
    expect(inspectWalletBirthday(db)).toEqual({ status: "pending" });
    expect(file.read()).toContain("[wallet] birthday pending");

    expect(maybeFreezeWalletBirthday(db, 950_123)).toBe(true);
    expect(inspectWalletBirthday(db)).toEqual({
      status: "ok",
      height: 950_123,
    });
    expect(file.read()).toContain("[wallet] birthday height=950123");
    expect(maybeFreezeWalletBirthday(db, 950_000)).toBe(false);
    expect(maybeFreezeWalletBirthday(db, 960_000)).toBe(false);
    expect(inspectWalletBirthday(db)).toEqual({
      status: "ok",
      height: 950_123,
    });

    db.keyValue.set(WALLET_BIRTHDAY_HEIGHT_KEY, "nope");
    expect(inspectWalletBirthday(db)).toEqual({ status: "none" });
    file.close();
    db.close();
  });

  test("compactFilterFrom uses birthday floor when set, else header min", () => {
    const db = createSqliteDatabase(":memory:");
    expect(compactFilterFrom(db)).toBeNull();
    db.headers.append([
      {
        height: 100,
        hashInternalHex: "aa".repeat(32),
        header: new Uint8Array(80),
      },
    ]);
    expect(compactFilterFrom(db)).toBe(100);
    db.keyValue.set(WALLET_BIRTHDAY_HEIGHT_KEY, "150");
    expect(compactFilterFrom(db)).toBe(150);
    db.keyValue.set(WALLET_BIRTHDAY_HEIGHT_KEY, "80");
    expect(compactFilterFrom(db)).toBe(100);
    db.close();
  });
});
