import { base58check } from "@scure/base";
import { createHash } from "node:crypto";
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

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}
const wifB58 = base58check(sha256);

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

  test("bip38 decodes slow", async () => {
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
  }, 10_000);

  test("wrong password fails with a clear error", async () => {
    await expect(
      decryptBip38ToWif(BIP38_FAST, "wrong", FAST_SCRYPT),
    ).rejects.toThrow(/incorrect password/i);
  });

  test("a malformed EC-mult flag byte is an invalid key, not a wrong password", async () => {
    // npm bip38's EC-mult path asserts `(flag & 0x24) === flag` before any
    // scrypt call ('Invalid private key.'). That is corrupt/garbage input,
    // not a password mismatch, so it must not surface as "incorrect password".
    const decoded = wifB58.decode(BIP38_SLOW);
    const corrupted = new Uint8Array(decoded);
    // Flag bits outside 0x24 trip npm bip38's own assertion, and this value
    // happens to keep the "6P…" shape (58 chars) so it still reaches that
    // check instead of being rejected earlier by isBip38Key.
    corrupted[2] = 0x08;
    const badKey = wifB58.encode(corrupted);
    await expect(decryptBip38ToWif(badKey, "whatever")).rejects.toThrow(
      /invalid password-protected WIF/i,
    );
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

  test("insert-before edit never leaves literal * in the password", () => {
    // Cursor placed before "ab" (masked "**") and the user types "z": the
    // widget inserts the literal char ahead of the untouched stars, so the
    // raw value it reports is "z**". Only append and end-backspace edits
    // are reconstructable from a masked value alone (see below), so this
    // falls back to a full replace of the visible edit — but that must
    // never leave a literal `*` from the old mask in the stored password.
    const next = nextPasswordFromMaskedInput("ab", "z**");
    expect(next).not.toContain("*");
  });

  test("backspace at the front truncates from the end (documented limit)", () => {
    // A masked value can't reveal *which* star was removed. Only append
    // and end-backspace are supported; any other shorter-all-stars edit
    // (e.g. deleting the first character) is treated as an end-truncate.
    expect(nextPasswordFromMaskedInput("ab", "*")).toBe("a");
  });

  test("full replace (e.g. select-all and retype) is not corrupted by stars", () => {
    expect(nextPasswordFromMaskedInput("ab", "hello")).toBe("hello");
  });
});
