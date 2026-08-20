import { describe, expect, test } from "bun:test";
import {
  classifyOnboardingSecret,
  maskPassword,
  nextPasswordFromMaskedInput,
  unlockBip38Secret,
} from "../../src/tui/onboarding-import.ts";
import { decryptBip38ToWif, isBip38Key } from "../../src/wallet/bip38.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import {
  decodeWif,
  inspectWalletSecret,
  parseWalletSecret,
} from "../../src/wallet/secret.ts";

/** BlueWallet tests/unit/bip38.test.ts (method 1, weak-scrypt ciphertext). */
const BIP38_FAST =
  "6PRVWUbkzq2VVjRuv58jpwVjTeN46MeNmzUHqUjQptBJUHGcBakduhrUNc";
/** BlueWallet skipped slow vector (EC-multiply). */
const BIP38_SLOW =
  "6PnU5voARjBBykwSddwCdcn6Eu9EcsK24Gs5zWxbJbPZYW7eiYQP8XgKbN";

const WIF_COMPRESSED =
  "L4vn2KxgMLrEVpxjfLwxfjnPPQMnx42DCjZJ2H7nN4mdHDyEUWXd";
const WIF_UNCOMPRESSED =
  "5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR";
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ADDR = "1Jq6MksXQVWzrznvZzxkV6oY57oWXD9TXB";

describe("isBip38Key", () => {
  test("is true for 58-character 6P keys", () => {
    expect(isBip38Key(BIP38_FAST)).toBe(true);
    expect(isBip38Key(`  ${BIP38_SLOW}  `)).toBe(true);
  });

  test("is false for WIF, zpub, mnemonic, and address", () => {
    expect(isBip38Key(WIF_COMPRESSED)).toBe(false);
    expect(isBip38Key(WIF_UNCOMPRESSED)).toBe(false);
    expect(isBip38Key(ZPUB)).toBe(false);
    expect(isBip38Key(MNEMONIC)).toBe(false);
    expect(isBip38Key(ADDR)).toBe(false);
    expect(isBip38Key("6Pshort")).toBe(false);
  });
});

describe("decodeWif", () => {
  test("marks 5… uncompressed and K/L compressed", () => {
    const raw = decodeWif(WIF_UNCOMPRESSED);
    expect(raw.compressed).toBe(false);
    expect(raw.privateKey.length).toBe(32);
    expect(decodeWif(WIF_COMPRESSED).compressed).toBe(true);
  });
});

describe("parseWalletSecret BIP38", () => {
  test("rejects a raw 6P key with a password error", () => {
    expect(() => parseWalletSecret(BIP38_FAST)).toThrow(
      /password-protected WIF requires a password/,
    );
  });

  test("inspect treats leftover 6P in KV as invalid", () => {
    const db = {
      keyValue: {
        get: () => BIP38_FAST,
        set: () => {},
      },
    };
    expect(inspectWalletSecret(db)).toEqual({
      status: "invalid",
      detail: "password-protected WIF requires a password",
    });
  });
});

const FAST_PASSWORD = "TestingOneTwoThree";
const FAST_SCRYPT = { N: 1, r: 8, p: 8 };

describe("decryptBip38ToWif (BlueWallet bip38.test.ts)", () => {
  test("bip38 decodes", async () => {
    const wif = await decryptBip38ToWif(
      BIP38_FAST,
      FAST_PASSWORD,
      FAST_SCRYPT,
    );
    expect(wif).toBe(WIF_UNCOMPRESSED);
  });

  test.skip("bip38 decodes slow", async () => {
    const wif = await decryptBip38ToWif(
      BIP38_SLOW,
      "qwerty",
    );
    expect(wif).toBe(
      "KxqRtpd9vFju297ACPKHrGkgXuberTveZPXbRDiQ3MXZycSQYtjc",
    );
    await expect(decryptBip38ToWif(BIP38_SLOW, "a")).rejects.toThrow(
      /incorrect password/i,
    );
  });

  test("wrong password fails with a clear error", async () => {
    await expect(
      decryptBip38ToWif(BIP38_FAST, "wrong", FAST_SCRYPT),
    ).rejects.toThrow(/incorrect password/i);
  });
});

describe("decrypt then derive", () => {
  test("fast vector becomes one uncompressed p2pkh", async () => {
    const wif = await decryptBip38ToWif(
      BIP38_FAST,
      FAST_PASSWORD,
      FAST_SCRYPT,
    );
    expect(parseWalletSecret(wif)).toEqual({
      kind: "wif",
      value: WIF_UNCOMPRESSED,
    });
    const w = deriveWatchWallet(wif);
    expect(w.kind).toBe("wif");
    expect(w.addresses).toHaveLength(1);
    expect(w.addresses[0]?.scriptType).toBe("p2pkh");
    expect(w.addresses[0]?.address).toBe(ADDR);
  });
});

describe("classifyOnboardingSecret", () => {
  test("sends 6P keys to the password step", () => {
    expect(classifyOnboardingSecret(`  ${BIP38_FAST}  `)).toEqual({
      action: "bip38",
      encrypted: BIP38_FAST,
    });
  });

  test("accepts a raw WIF without a password step", () => {
    expect(classifyOnboardingSecret(WIF_UNCOMPRESSED)).toEqual({
      action: "save",
      secret: WIF_UNCOMPRESSED,
    });
  });

  test("still rejects junk", () => {
    expect(() => classifyOnboardingSecret("not-a-secret")).toThrow();
  });
});

describe("unlockBip38Secret", () => {
  test("rejects an empty password", async () => {
    await expect(unlockBip38Secret(BIP38_FAST, "   ")).rejects.toThrow(
      /password is required/i,
    );
  });

  test("returns the plain WIF", async () => {
    await expect(
      unlockBip38Secret(BIP38_FAST, FAST_PASSWORD, FAST_SCRYPT),
    ).resolves.toBe(WIF_UNCOMPRESSED);
  });
});

describe("masked password input", () => {
  test("masks to stars and applies edits", () => {
    expect(maskPassword("ab")).toBe("**");
    expect(nextPasswordFromMaskedInput("ab", "***")).toBe("ab*");
    expect(nextPasswordFromMaskedInput("ab", "*")).toBe("a");
    expect(nextPasswordFromMaskedInput("ab", "xyz")).toBe("xyz");
  });
});
