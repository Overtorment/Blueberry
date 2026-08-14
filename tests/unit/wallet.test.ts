/**
 * Wallet module suite.
 *
 * BIP84 abandon / zpub vectors from BlueWallet:
 * https://github.com/BlueWallet/BlueWallet/blob/master/tests/unit/hd-segwit-bech32-wallet.test.js
 */
import { describe, expect, test } from "bun:test";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { bytesToHex } from "bip158";
import { config } from "../../src/config.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { BIP84_ACCOUNT_PATH, deriveWatchWallet } from "../../src/wallet/derive.ts";
import {
  BIP84_ZPUB_VERSIONS,
  WALLET_SECRET_KEY,
  hasWalletSecret,
  inspectWalletSecret,
  loadWalletSecret,
  parseWalletSecret,
  saveWalletSecret,
} from "../../src/wallet/secret.ts";
import { createWallet } from "../../src/wallet/wallet.ts";
import { loadWatchGaps, saveWatchGaps } from "../../src/wallet/watch-gaps.ts";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const BLUE_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

const BLUE_EXTERNAL_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const BLUE_EXTERNAL_1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const BLUE_INTERNAL_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
const BLUE_EXTERNAL_0_SCRIPT =
  "0014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2";

/** BlueWallet #4993 — SeedSigner-style BIP84 zpub. */
const SEEDSIGNER_ZPUB =
  "zpub6rutAggZJCvkgZg3BAqNGAxCkx1khxCE6g6jyJugMfZ1zgkVdUWSdnzSRpWX1GYVZXCpQFS87BUsvgXXJBpsJVroiHbu4Js2TY69zbWcTNb";
const SEEDSIGNER_EXTERNAL_0 = "bc1q68y6r45k4kvxe42xl37dgjueg2suqwnh4ze0sr";

describe("BIP84 derive (BlueWallet vectors)", () => {
  test("abandon mnemonic → zpub, addresses, script, default gaps", () => {
    const wallet = deriveWatchWallet(ABANDON);
    const zpub = HDKey.fromMasterSeed(
      mnemonicToSeedSync(ABANDON),
      BIP84_ZPUB_VERSIONS,
    )
      .derive(BIP84_ACCOUNT_PATH)
      .publicExtendedKey;
    expect(zpub).toBe(BLUE_ZPUB);
    expect(wallet.addresses).toHaveLength(config.initialWatchCount * 2);
    expect(wallet.addresses[0]?.address).toBe(BLUE_EXTERNAL_0);
    expect(bytesToHex(wallet.addresses[0]!.scriptPubKey)).toBe(
      BLUE_EXTERNAL_0_SCRIPT,
    );
    expect(wallet.addresses[0]?.path).toBe("m/84'/0'/0'/0/0");
    expect(wallet.addresses[config.initialWatchCount]?.path).toBe(
      "m/84'/0'/0'/1/0",
    );
    expect(wallet.addresses[config.initialWatchCount]?.address).toBe(
      BLUE_INTERNAL_0,
    );
  });

  test("abandon → first two receive + first change (small gaps)", () => {
    const wallet = deriveWatchWallet(ABANDON, { external: 2, internal: 1 });
    expect(wallet.addresses.map((a) => a.address)).toEqual([
      BLUE_EXTERNAL_0,
      BLUE_EXTERNAL_1,
      BLUE_INTERNAL_0,
    ]);
  });

  test("account zpub matches mnemonic addresses and scripts", () => {
    const fromMnemonic = deriveWatchWallet(ABANDON, {
      external: 3,
      internal: 2,
    });
    const fromZpub = deriveWatchWallet(BLUE_ZPUB, {
      external: 3,
      internal: 2,
    });
    expect(fromZpub.secret).toBe(BLUE_ZPUB);
    expect(fromZpub.addresses.map((a) => a.address)).toEqual(
      fromMnemonic.addresses.map((a) => a.address),
    );
    expect(fromZpub.addresses.map((a) => a.path)).toEqual(
      fromMnemonic.addresses.map((a) => a.path),
    );
    expect(fromZpub.scripts.map(bytesToHex)).toEqual(
      fromMnemonic.scripts.map(bytesToHex),
    );
  });

  test("SeedSigner BIP84 zpub first receive", () => {
    const w = deriveWatchWallet(SEEDSIGNER_ZPUB, { external: 1, internal: 0 });
    expect(w.addresses[0]?.address).toBe(SEEDSIGNER_EXTERNAL_0);
  });

  test("dual and numeric gap shapes", () => {
    const dual = deriveWatchWallet(ABANDON, { external: 3, internal: 2 });
    expect(dual.addresses).toHaveLength(5);
    expect(dual.addresses.filter((a) => !a.change)).toHaveLength(3);
    expect(dual.addresses.filter((a) => a.change)).toHaveLength(2);
    expect(deriveWatchWallet(ABANDON, 4).addresses).toHaveLength(8);
  });
});

describe("parseWalletSecret", () => {
  test("trims mnemonic; accepts account zpub", () => {
    expect(parseWalletSecret(`  ${ABANDON}  `)).toEqual({
      kind: "mnemonic",
      value: ABANDON,
    });
    expect(parseWalletSecret(BLUE_ZPUB)).toEqual({
      kind: "zpub",
      value: BLUE_ZPUB,
    });
    expect(
      parseWalletSecret(ABANDON.replaceAll(" ", "  ").toUpperCase()),
    ).toEqual({
      kind: "mnemonic",
      value: ABANDON,
    });
  });

  test("rejects invalid mnemonic, empty, xpub, vpub, master zpub, French words", () => {
    expect(() =>
      parseWalletSecret("not a real mnemonic phrase at all"),
    ).toThrow();
    expect(() => parseWalletSecret("")).toThrow(/empty/);
    expect(() => parseWalletSecret("   ")).toThrow(/empty/);

    const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON))
      .derive(BIP84_ACCOUNT_PATH)
      .publicExtendedKey;
    expect(() => parseWalletSecret(xpub)).toThrow(/zpub/);
    expect(() => deriveWatchWallet(xpub, 1)).toThrow();
    expect(() => parseWalletSecret("zprv" + "1".repeat(107))).toThrow(
      /mainnet account zpub/,
    );

    const vpub = HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON), {
      private: 0x045f18bc,
      public: 0x045f1cf6,
    })
      .derive(BIP84_ACCOUNT_PATH)
      .publicExtendedKey;
    expect(vpub.startsWith("vpub")).toBe(true);
    expect(() => parseWalletSecret(vpub)).toThrow(/mainnet account zpub/);

    const master = HDKey.fromMasterSeed(
      mnemonicToSeedSync(ABANDON),
      BIP84_ZPUB_VERSIONS,
    ).publicExtendedKey;
    expect(() => parseWalletSecret(master)).toThrow(/account-level/);

    // BlueWallet accepts French seeds; blueberry is English-only.
    expect(() =>
      parseWalletSecret(
        "abaisser abaisser abaisser abaisser abaisser abaisser abaisser abaisser abaisser abaisser abaisser abeille",
      ),
    ).toThrow(/mnemonic/);
  });
});

describe("wallet_secret KV", () => {
  test("has / load / save round-trip", () => {
    const db = createSqliteDatabase(":memory:");
    expect(hasWalletSecret(db)).toBe(false);
    expect(() => loadWalletSecret(db)).toThrow();
    saveWalletSecret(db, ABANDON);
    expect(hasWalletSecret(db)).toBe(true);
    expect(loadWalletSecret(db)).toBe(ABANDON);
    expect(db.keyValue.get(WALLET_SECRET_KEY)).toBe(ABANDON);
    db.close();
  });

  test("inspect: missing / ok / invalid leaves bad row", () => {
    const db = createSqliteDatabase(":memory:");
    expect(inspectWalletSecret(db)).toEqual({ status: "missing" });
    saveWalletSecret(db, ABANDON);
    expect(inspectWalletSecret(db)).toEqual({
      status: "ok",
      value: ABANDON,
    });
    db.keyValue.set(WALLET_SECRET_KEY, "not a real mnemonic phrase at all");
    const bad = inspectWalletSecret(db);
    expect(bad.status).toBe("invalid");
    if (bad.status !== "invalid") throw new Error("expected invalid");
    expect(bad.detail.length).toBeGreaterThan(0);
    expect(db.keyValue.get(WALLET_SECRET_KEY)).toBe(
      "not a real mnemonic phrase at all",
    );
    db.close();
  });
});

describe("createWallet", () => {
  test("loads KV secret and exposes BlueWallet first address", () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ABANDON);
    const wallet = createWallet(db);
    expect(wallet.gaps()).toEqual({
      external: config.initialWatchCount,
      internal: config.initialWatchCount,
    });
    expect(wallet.snapshot().addresses[0]?.address).toBe(BLUE_EXTERNAL_0);
    expect(wallet.scripts()).toHaveLength(config.initialWatchCount * 2);
    db.close();
  });

  test("secret override + addressGap (does not write secret to KV)", () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON, addressGap: 3 });
    expect(wallet.gaps()).toEqual({ external: 3, internal: 3 });
    expect(wallet.snapshot().addresses).toHaveLength(6);
    expect(db.keyValue.get(WALLET_SECRET_KEY)).toBeNull();
    expect(loadWatchGaps(db)).toEqual({ external: 3, internal: 3 });
    db.close();
  });

  test("throws when secret missing or invalid in KV", () => {
    const db = createSqliteDatabase(":memory:");
    expect(() => createWallet(db)).toThrow(/wallet_secret/);
    db.keyValue.set(WALLET_SECRET_KEY, "not a real mnemonic phrase at all");
    expect(() => createWallet(db)).toThrow();
    db.close();
  });

  test("syncFromDb re-derives on gap growth; no-op when unchanged", () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON, addressGap: 2 });
    expect(wallet.scripts()).toHaveLength(4);
    const scripts1 = wallet.scripts();
    expect(wallet.syncFromDb().grew).toBe(false);
    expect(wallet.scripts()).toBe(scripts1);
    expect(wallet.refresh()).toBe(wallet.snapshot());
    expect(wallet.scripts()).toBe(scripts1);

    saveWatchGaps(db, { external: 5, internal: 2 });
    expect(wallet.syncFromDb().grew).toBe(true);
    expect(wallet.gaps()).toEqual({ external: 5, internal: 2 });
    expect(wallet.scripts()).toHaveLength(7);
    expect(wallet.snapshot().addresses[0]?.address).toBe(BLUE_EXTERNAL_0);
    db.close();
  });

  test("peekGaps reads DB without changing in-memory derive", () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON, addressGap: 2 });
    saveWatchGaps(db, { external: 9, internal: 2 });
    expect(wallet.peekGaps()).toEqual({ external: 9, internal: 2 });
    expect(wallet.gaps()).toEqual({ external: 2, internal: 2 });
    expect(wallet.scripts()).toHaveLength(4);
    db.close();
  });

  test("zpub from KV works end-to-end", () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, BLUE_ZPUB);
    const wallet = createWallet(db, { addressGap: 2 });
    expect(wallet.snapshot().secret).toBe(BLUE_ZPUB);
    expect(wallet.snapshot().addresses[0]?.address).toBe(BLUE_EXTERNAL_0);
    db.close();
  });

  test("WIF from KV unwraps to four scripts (kind wif)", () => {
    const wif = "L4vn2KxgMLrEVpxjfLwxfjnPPQMnx42DCjZJ2H7nN4mdHDyEUWXd";
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, wif);
    const wallet = createWallet(db);
    const snap = wallet.snapshot();
    expect(snap.kind).toBe("wif");
    expect(snap.secret).toBe(wif);
    expect(snap.addresses).toHaveLength(4);
    expect(wallet.scripts()).toHaveLength(4);
    expect(
      snap.addresses.find((a) => a.scriptType === "p2wpkh")?.address,
    ).toBe("bc1q3rl0mkyk0zrtxfmqn9wpcd3gnaz00yv9yp0hxe");
    db.close();
  });
});
