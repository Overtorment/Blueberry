import { CryptoPSBT } from "@keystonehq/bc-ur-registry";

/** BlueWallet DynamicQRCode default fragment capacity. */
export const BC_UR_PSBT_CAPACITY = 175;

/**
 * Encode a PSBT (binary or hex) as BC-UR v2 `crypto-psbt` fragments.
 * Matches BlueWallet `encodeURv2` PSBT branch: one part per `fragmentsLength`.
 */
export function encodeCryptoPsbtUrFragments(
  psbt: Uint8Array | string,
  capacity: number = BC_UR_PSBT_CAPACITY,
): string[] {
  const bytes =
    typeof psbt === "string"
      ? Buffer.from(psbt, "hex")
      : Buffer.from(psbt);
  const encoder = new CryptoPSBT(bytes).toUREncoder(capacity);
  const parts: string[] = [];
  for (let i = 0; i < encoder.fragmentsLength; i++) {
    parts.push(encoder.nextPart());
  }
  return parts;
}
