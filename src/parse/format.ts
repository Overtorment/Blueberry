export function shortTxid(txid: string, keep = 8): string {
  if (txid.length <= keep * 2) return txid;
  return `${txid.slice(0, keep)}…${txid.slice(-keep)}`;
}

/** First 6 hex chars of txid + ":" + vout (Send UTXO list). */
export function shortOutpoint(txid: string, vout: number): string {
  return `${txid.slice(0, 6)}:${vout}`;
}

/** Eighth-cell partials for a smooth leading edge (after full █ cells). */
const BAR_PARTIAL = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

/**
 * Fixed-width relative bar: █ full cells, eighth partials, ░ empty track.
 * Max value fills the width; any positive dust keeps at least ▏.
 */
export function utxoValueBar(
  value: bigint,
  maxValue: bigint,
  width = 30,
): string {
  if (value <= 0n || maxValue <= 0n || width <= 0) return "";
  if (value >= maxValue) return "█".repeat(width);

  const steps = width * 8;
  let filled = Number((value * BigInt(steps) + maxValue / 2n) / maxValue);
  filled = Math.min(steps, Math.max(1, filled));

  const full = Math.floor(filled / 8);
  const rem = filled % 8;
  const head = "█".repeat(full) + BAR_PARTIAL[rem];
  const used = full + (rem > 0 ? 1 : 0);
  return head + "░".repeat(Math.max(0, width - used));
}

export type BtcParts = {
  sign: "" | "-" | "+";
  whole: string;
  /** Bright fractional digits; always at least one. */
  fracSignificant: string;
  /** Trailing zeros to dim (may be empty). */
  fracTrailing: string;
};

/** Split sats for trailing-zero styling; keeps ≥1 fractional digit bright. */
export function splitBtc(
  sats: bigint,
  opts?: { plus?: boolean },
): BtcParts {
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const whole = (abs / 100000000n).toString();
  const frac = (abs % 100000000n).toString().padStart(8, "0");
  let end = 8;
  while (end > 1 && frac[end - 1] === "0") end--;
  let sign: "" | "-" | "+" = "";
  if (neg) sign = "-";
  else if (opts?.plus && sats > 0n) sign = "+";
  return {
    sign,
    whole,
    fracSignificant: frac.slice(0, end),
    fracTrailing: frac.slice(end),
  };
}

export function formatBtc(sats: bigint): string {
  const p = splitBtc(sats);
  return `${p.sign}${p.whole}.${p.fracSignificant}${p.fracTrailing} BTC`;
}

/** Parse a BTC decimal string to sats; null if not a valid non-negative amount. */
export function parseBtcToSats(input: string): bigint | null {
  const t = input.trim().replace(/\s*BTC\s*$/i, "");
  if (!t || !/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  if (frac.length > 8) return null;
  return BigInt(whole!) * 100000000n + BigInt(frac.padEnd(8, "0"));
}

/** True for the send-max token: trim, then case-insensitive exact "max". */
export function isSendMaxAmount(input: string): boolean {
  return input.trim().toLowerCase() === "max";
}

export function formatNetDelta(sats: bigint): string {
  const p = splitBtc(sats, { plus: true });
  return `${p.sign}${p.whole}.${p.fracSignificant}${p.fracTrailing} BTC`;
}
