import { describe, expect, test } from "bun:test";
import { p2sh, p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { isAddressValid } from "../../src/wallet/is-address-valid.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("isAddressValid (BlueWallet rules)", () => {
  test("accepts mainnet p2wpkh, p2pkh, p2sh-p2wpkh, and taproot", () => {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    const native = p2wpkh(root.derive("m/84'/0'/0'/0/0").publicKey!);
    const nested = p2sh(p2wpkh(root.derive("m/49'/0'/0'/0/0").publicKey!));

    expect(isAddressValid(native.address!)).toBe(true);
    expect(isAddressValid("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe(true);
    expect(isAddressValid(nested.address!)).toBe(true);
    // BIP-341 example taproot
    expect(
      isAddressValid(
        "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      ),
    ).toBe(true);
  });

  test("rejects garbage, testnet, bad checksum, and witness v2+", () => {
    expect(isAddressValid("")).toBe(false);
    expect(isAddressValid("not-an-address")).toBe(false);
    expect(isAddressValid("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).toBe(
      false,
    );
    expect(
      isAddressValid("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4x"),
    ).toBe(false);
    // bech32m witness v2 (rejected by BlueWallet rules)
    expect(
      isAddressValid(
        "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs",
      ),
    ).toBe(false);
  });

  test("trims whitespace around a valid address", () => {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    const addr = p2wpkh(root.derive("m/84'/0'/0'/0/0").publicKey!).address!;
    expect(isAddressValid(`  ${addr}  `)).toBe(true);
  });
});

