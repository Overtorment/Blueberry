import { encodeCryptoPsbtUrFragments } from "../wallet/encode-psbt-ur.ts";
import { qrCompactSize } from "./qr-ascii.ts";

/** Capacities to try, largest first (BlueWallet default → denser fragments). */
const CAPACITIES = [175, 150, 120, 100, 80, 60, 50, 40, 30, 20, 15, 12, 10] as const;

function longestPart(parts: string[]): string {
  let best = parts[0]!;
  for (const part of parts) {
    if (part.length > best.length) best = part;
  }
  return best;
}

function encodeCapacity(
  psbtHex: string,
  capacity: number,
): string[] | null {
  try {
    const parts = encodeCryptoPsbtUrFragments(psbtHex, capacity);
    return parts.length === 0 ? null : parts;
  } catch {
    return null;
  }
}

/**
 * Encode a PSBT as BC-UR v2 fragments sized so the compact QR fits
 * `maxWidth` × `maxHeight` terminal cells.
 * If nothing fits, returns the smallest-capacity encode (least oversized).
 * If every capacity fails to encode, returns empty `parts`.
 *
 * Capacities are monotone (larger fragment → larger QR), so this binary-searches
 * for the largest capacity that fits. One QR size check per try (longest part).
 */
export function fitCryptoPsbtUrQr(
  psbtHex: string,
  maxWidth: number,
  maxHeight: number,
): { parts: string[]; capacity: number } {
  const maxW = Math.max(8, maxWidth);
  const maxH = Math.max(4, maxHeight);

  let best: { parts: string[]; capacity: number } | null = null;
  let smallest: { parts: string[]; capacity: number } | null = null;
  let lo = 0;
  let hi = CAPACITIES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const capacity = CAPACITIES[mid]!;
    const parts = encodeCapacity(psbtHex, capacity);
    if (!parts) {
      lo = mid + 1;
      continue;
    }
    if (!smallest || capacity < smallest.capacity) {
      smallest = { parts, capacity };
    }
    const { width, height } = qrCompactSize(longestPart(parts));
    if (width <= maxW && height <= maxH) {
      best = { parts, capacity };
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  return best ?? smallest ?? { parts: [], capacity: 0 };
}
