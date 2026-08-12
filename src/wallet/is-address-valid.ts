import { secp256k1 } from "@noble/curves/secp256k1";
import { address as btcAddress } from "bitcoinjs-lib";
import type { AddressScriptType } from "./types.ts";

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

/**
 * Classify address forms supported as fixed single-address watches.
 * Destination validation is broader (for example P2WSH), but watched
 * addresses need a known input shape for PSBT fee estimation.
 */
export function watchAddressScriptType(address: string): AddressScriptType {
  const value = address.trim();
  if (!isAddressValid(value)) throw new Error("invalid mainnet address");

  if (value.toLowerCase().startsWith("bc1")) {
    const decoded = btcAddress.fromBech32(value);
    if (decoded.version === 0) {
      if (decoded.data.length === 20) return "p2wpkh";
      if (decoded.data.length === 32) {
        throw new Error("P2WSH watch addresses are unsupported");
      }
      throw new Error("unsupported witness v0 address");
    }
    if (decoded.version === 1 && decoded.data.length === 32) return "p2tr";
    throw new Error("unsupported witness address");
  }

  const { version } = btcAddress.fromBase58Check(value);
  if (version === 0x00) return "p2pkh";
  if (version === 0x05) return "p2sh-p2wpkh";
  throw new Error("unsupported mainnet address version");
}
