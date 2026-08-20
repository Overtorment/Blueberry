import { describe, expect, test } from "bun:test";
import { isBip38Key } from "../../src/wallet/bip38.ts";
import {
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
