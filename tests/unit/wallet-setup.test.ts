import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletSetup } from "../../src/boot/wallet-setup.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { encryptSecret } from "../../src/wallet/encryption.ts";
import { inspectWalletSecret, parseWalletSecret, unlockStoredWalletSecret, WALLET_SECRET_KEY } from "../../src/wallet/secret.ts";
import { saveSyncFromYear } from "../../src/sync-year.ts";
import { markWalletBirthdayPending } from "../../src/wallet/birthday.ts";

const SECRET = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASSWORD = "a disposable fixture password";

describe("protected wallet setup with SQLite", () => {
  test("create/import never persists plaintext, then survives restart and unlock", async () => {
    for (const created of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "blueberry-protected-setup-"));
      const path = join(dir, "wallet.sqlite");
      const db = createSqliteDatabase(path);
      try {
        const setup = createWalletSetup({
          parse: (raw) => parseWalletSecret(raw).value,
          encrypt: encryptSecret,
          commit: (encrypted, year, isNew) => db.transaction(() => {
            db.keyValue.set(WALLET_SECRET_KEY, encrypted);
            saveSyncFromYear(db, year);
            if (isNew) markWalletBirthdayPending(db);
          }),
        });
        setup.stage(SECRET);
        expect(db.keyValue.get(WALLET_SECRET_KEY)).toBeNull();
        await setup.save(2026, PASSWORD, created);
        expect(inspectWalletSecret(db)).toEqual({ status: "encrypted" });
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(path + suffix)) expect(readFileSync(path + suffix).includes(Buffer.from(SECRET))).toBe(false);
        }
        db.close();
        const reopened = createSqliteDatabase(path);
        try {
          await expect(unlockStoredWalletSecret(reopened, "incorrect password")).rejects.toThrow(/wrong password/);
          expect(await unlockStoredWalletSecret(reopened, PASSWORD)).toBe(SECRET);
        } finally {
          reopened.close();
        }
      } finally {
        // Bun's close is idempotent.
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
