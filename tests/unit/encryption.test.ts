import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  decryptSecret,
  encryptSecret,
  ENCRYPTED_SECRET_PREFIX,
  isEncryptedSecret,
  isWellFormedEncryptedSecret,
} from "../../src/wallet/encryption.ts";
import {
  WALLET_SECRET_KEY,
  encryptStoredWalletSecret,
  inspectWalletSecret,
  loadWalletSecret,
  saveWalletSecret,
  unlockStoredWalletSecret,
} from "../../src/wallet/secret.ts";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("encryptSecret / decryptSecret", () => {
  test("round-trip", async () => {
    const blob = await encryptSecret(ABANDON, "correct horse");
    expect(blob.startsWith(ENCRYPTED_SECRET_PREFIX)).toBe(true);
    expect(isWellFormedEncryptedSecret(blob)).toBe(true);
    expect(await decryptSecret(blob, "correct horse")).toBe(ABANDON);
  });

  test("NFC-normalizes the password", async () => {
    const composed = "café";
    const decomposed = "cafe\u0301";
    const blob = await encryptSecret(ABANDON, composed);
    expect(await decryptSecret(blob, decomposed)).toBe(ABANDON);
  });

  test("wrong password fails", async () => {
    const blob = await encryptSecret(ABANDON, "right");
    await expect(decryptSecret(blob, "wrong")).rejects.toThrow(/wrong password/);
  });

  test("empty password is rejected", async () => {
    await expect(encryptSecret(ABANDON, "")).rejects.toThrow(/password/);
  });

  test("plain secrets are not encrypted blobs", () => {
    expect(isEncryptedSecret(ABANDON)).toBe(false);
    expect(
      isEncryptedSecret(
        "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1A",
      ),
    ).toBe(false);
  });

  test("rejects an odd-length ciphertext before key derivation", () => {
    const blob = `${ENCRYPTED_SECRET_PREFIX}${"00".repeat(16)}:${"00".repeat(12)}:${"00".repeat(16)}:0`;
    expect(isWellFormedEncryptedSecret(blob)).toBe(false);
  });
});

describe("encrypted wallet_secret KV", () => {
  test("inspect / load / unlock", async () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ABANDON);
    expect(inspectWalletSecret(db)).toEqual({ status: "ok", value: ABANDON });

    const plain = await encryptStoredWalletSecret(db, "pw");
    expect(plain).toBe(ABANDON);
    expect(inspectWalletSecret(db)).toEqual({ status: "encrypted" });
    expect(isEncryptedSecret(db.keyValue.get(WALLET_SECRET_KEY)!)).toBe(true);
    expect(() => loadWalletSecret(db)).toThrow(/encrypted/);

    const unlocked = await unlockStoredWalletSecret(db, "pw");
    expect(unlocked).toBe(ABANDON);
    db.close();
  });

  test("inspect treats a broken blob as invalid", () => {
    const db = createSqliteDatabase(":memory:");
    db.keyValue.set(WALLET_SECRET_KEY, `${ENCRYPTED_SECRET_PREFIX}not-a-blob`);
    expect(inspectWalletSecret(db)).toEqual({
      status: "invalid",
      detail: "invalid encrypted wallet_secret",
    });
    db.close();
  });

  test("fails closed and retries cleanup when a reader blocks the checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blueberry-encryption-busy-"));
    const path = join(dir, "wallet.sqlite");
    const secretBytes = Buffer.from(ABANDON);
    let reader: BunDatabase | null = null;
    let db: ReturnType<typeof createSqliteDatabase> | null = null;
    try {
      const initial = createSqliteDatabase(path);
      saveWalletSecret(initial, ABANDON);
      initial.close();

      db = createSqliteDatabase(path);
      reader = new BunDatabase(path);
      reader.exec("BEGIN;");
      reader
        .query("SELECT value FROM key_value WHERE key = ?")
        .get(WALLET_SECRET_KEY);

      await expect(encryptStoredWalletSecret(db, "pw")).rejects.toThrow(
        /plaintext/,
      );
      expect(isEncryptedSecret(db.keyValue.get(WALLET_SECRET_KEY)!)).toBe(true);
      expect(readFileSync(path).includes(secretBytes)).toBe(true);

      reader.exec("ROLLBACK;");
      reader.close();
      reader = null;

      expect(await encryptStoredWalletSecret(db, "pw")).toBe(ABANDON);
      expect(readFileSync(path).includes(secretBytes)).toBe(false);
    } finally {
      reader?.close();
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unlock fails closed if pending plaintext cleanup fails", async () => {
    const stored = await encryptSecret(ABANDON, "pw");
    const db = {
      keyValue: {
        get: () => stored,
        set: () => {},
        setSecure: () => {
          throw new Error("checkpoint busy");
        },
      },
    };

    await expect(unlockStoredWalletSecret(db, "pw")).rejects.toThrow(
      /checkpoint busy/,
    );
  });

  test("removes the old plaintext from the database and WAL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "blueberry-encryption-"));
    const path = join(dir, "wallet.sqlite");
    const secretBytes = Buffer.from(ABANDON);
    try {
      const plainDb = createSqliteDatabase(path);
      saveWalletSecret(plainDb, ABANDON);
      plainDb.close();
      expect(readFileSync(path).includes(secretBytes)).toBe(true);

      const db = createSqliteDatabase(path);
      await encryptStoredWalletSecret(db, "pw");
      db.close();

      expect(readFileSync(path).includes(secretBytes)).toBe(false);
      const walPath = `${path}-wal`;
      if (existsSync(walPath)) {
        expect(readFileSync(walPath).includes(secretBytes)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
