import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  WALLET_BIRTHDAY_HEIGHT_KEY,
  inspectWalletBirthday,
  markWalletBirthdayPending,
  maybeFreezeWalletBirthday,
} from "../../src/wallet/birthday.ts";

describe("wallet birthday", () => {
  test("none → pending → freeze once; ignore later tips; garbage → none", () => {
    const db = createSqliteDatabase(":memory:");
    expect(inspectWalletBirthday(db)).toEqual({ status: "none" });
    expect(maybeFreezeWalletBirthday(db, 100)).toBe(false);

    markWalletBirthdayPending(db);
    expect(inspectWalletBirthday(db)).toEqual({ status: "pending" });

    expect(maybeFreezeWalletBirthday(db, 950_123)).toBe(true);
    expect(inspectWalletBirthday(db)).toEqual({
      status: "ok",
      height: 950_123,
    });
    expect(maybeFreezeWalletBirthday(db, 950_000)).toBe(false);
    expect(maybeFreezeWalletBirthday(db, 960_000)).toBe(false);
    expect(inspectWalletBirthday(db)).toEqual({
      status: "ok",
      height: 950_123,
    });

    db.keyValue.set(WALLET_BIRTHDAY_HEIGHT_KEY, "nope");
    expect(inspectWalletBirthday(db)).toEqual({ status: "none" });
    db.close();
  });
});
