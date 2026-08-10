import { encodeCryptoPsbtUrFragments } from "../wallet/encode-psbt-ur.ts";
import { qrCompactSize } from "./qr-ascii.ts";

/** Capacities to try, largest first (BlueWallet default → denser fragments). */
const CAPACITIES = [175, 150, 120, 100, 80, 60, 50, 40, 30, 20, 15, 12, 10] as const;

/**
 * Encode a PSBT as BC-UR v2 fragments sized so the compact QR fits
 * `maxWidth` × `maxHeight` terminal cells.
 * If nothing fits, returns the smallest-capacity encode (least oversized).
 */
export function fitCryptoPsbtUrQr(
  psbtHex: string,
  maxWidth: number,
  maxHeight: number,
): { parts: string[]; capacity: number } {
  const maxW = Math.max(8, maxWidth);
  const maxH = Math.max(4, maxHeight);

  let smallest: { parts: string[]; capacity: number } | null = null;
  for (const capacity of CAPACITIES) {
    let parts: string[];
    try {
      parts = encodeCryptoPsbtUrFragments(psbtHex, capacity);
    } catch {
      continue;
    }
    if (parts.length === 0) continue;

    smallest = { parts, capacity };

    const fits = parts.every((part) => {
      const { width, height } = qrCompactSize(part);
      return width <= maxW && height <= maxH;
    });
    if (fits) return { parts, capacity };
  }

  if (!smallest) {
    throw new Error("failed to encode PSBT as BC-UR");
  }
  return smallest;
}
