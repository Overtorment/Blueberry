/**
 * Single-address watch-only — vectors reuse BlueWallet WIF primary addresses
 * and BIP-341 taproot example from is-address-valid tests.
 */
import { address as btcAddress } from "bitcoinjs-lib";
import { bytesToHex } from "bip158";
import { describe, expect, test } from "bun:test";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
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

describe("deriveWatchWallet address", () => {
  test("native segwit → one p2wpkh script matching toOutputScript", () => {
    const w = deriveWatchWallet(ADDR_BECH32);
    expect(w.kind).toBe("address");
    expect(w.secret).toBe(ADDR_BECH32);
    expect(w.addresses).toHaveLength(1);
    expect(w.scripts).toHaveLength(1);
    const a = w.addresses[0]!;
    expect(a.address).toBe(ADDR_BECH32);
    expect(a.path).toBe("address/0");
    expect(a.change).toBe(false);
    expect(a.index).toBe(0);
    expect(a.scriptType).toBe("p2wpkh");
    expect(bytesToHex(a.scriptPubKey)).toBe(
      Buffer.from(btcAddress.toOutputScript(ADDR_BECH32)).toString("hex"),
    );
  });

  test("legacy / nested / taproot labels and script bytes", () => {
    expect(deriveWatchWallet(ADDR_LEGACY).addresses[0]?.scriptType).toBe(
      "p2pkh",
    );
    expect(deriveWatchWallet(ADDR_P2SH).addresses[0]?.scriptType).toBe(
      "p2sh-p2wpkh",
    );
    expect(deriveWatchWallet(ADDR_TAPROOT).addresses[0]?.scriptType).toBe(
      "p2tr",
    );
  });

  test("gaps argument ignored", () => {
    const a = deriveWatchWallet(ADDR_BECH32, 1);
    const b = deriveWatchWallet(ADDR_BECH32, {
      external: 500,
      internal: 500,
    });
    expect(a.addresses).toHaveLength(1);
    expect(b.addresses).toHaveLength(1);
    expect(bytesToHex(a.scripts[0]!)).toBe(bytesToHex(b.scripts[0]!));
  });
});
