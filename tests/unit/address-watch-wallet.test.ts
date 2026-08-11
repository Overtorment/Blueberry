/**
 * Single-address watch-only — vectors reuse BlueWallet WIF primary addresses
 * and BIP-341 taproot example from is-address-valid tests.
 */
import { describe, expect, test } from "bun:test";
import { parseWalletSecret } from "../../src/wallet/secret.ts";

const ADDR_BECH32 = "bc1q3rl0mkyk0zrtxfmqn9wpcd3gnaz00yv9yp0hxe";
const ADDR_LEGACY = "14YZ6iymQtBVQJk6gKnLCk49UScJK7SH4M";
const ADDR_P2SH = "3CKN8HTCews4rYJYsyub5hjAVm5g5VFdQJ";
const ADDR_TAPROOT =
  "bc1pm6lqlel3qxefsx0v39nshtghasvvp6ghn3e5hd5q280j5m9h7csqrkzssu";
const BIP341_TAPROOT =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";

describe("parseWalletSecret address", () => {
  test("accepts mainnet legacy / nested / native / taproot (trimmed)", () => {
    expect(parseWalletSecret(`  ${ADDR_BECH32}  `)).toEqual({
      kind: "address",
      value: ADDR_BECH32,
    });
    expect(parseWalletSecret(ADDR_LEGACY).kind).toBe("address");
    expect(parseWalletSecret(ADDR_P2SH).kind).toBe("address");
    expect(parseWalletSecret(ADDR_TAPROOT).kind).toBe("address");
    expect(parseWalletSecret(BIP341_TAPROOT).kind).toBe("address");
  });

  test("rejects testnet and garbage before falling through to mnemonic", () => {
    expect(() =>
      parseWalletSecret("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"),
    ).toThrow(/mnemonic|address|invalid/i);
    expect(() => parseWalletSecret("not-an-address")).toThrow();
  });

  test("WIF still wins over address-shaped confusion", () => {
    const wif = "L4vn2KxgMLrEVpxjfLwxfjnPPQMnx42DCjZJ2H7nN4mdHDyEUWXd";
    expect(parseWalletSecret(wif).kind).toBe("wif");
  });
});
