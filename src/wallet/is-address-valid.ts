import { secp256k1 } from "@noble/curves/secp256k1";
import { address as btcAddress } from "bitcoinjs-lib";

/**
 * Mainnet address check — same rules as BlueWallet `LegacyWallet.isAddressValid`:
 * `toOutputScript`, then for `bc1` bech32: v0 ok, v1 taproot must be 32-byte valid
 * x-only point, higher witness versions rejected.
 */
export function isAddressValid(address: string): boolean {
  const value = address.trim();
  if (!value) return false;

  try {
    if (!value.toLowerCase().startsWith("bc1")) {
      btcAddress.toOutputScript(value);
      return true;
    }

    const decoded = btcAddress.fromBech32(value);
    if (decoded.version === 0) {
      btcAddress.toOutputScript(value);
      return true;
    }
    if (decoded.version === 1) {
      if (decoded.data.length !== 32) return false;
      const compressed = new Uint8Array(33);
      compressed[0] = 2;
      compressed.set(decoded.data, 1);
      try {
        secp256k1.ProjectivePoint.fromHex(
          Buffer.from(compressed).toString("hex"),
        );
      } catch {
        return false;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
