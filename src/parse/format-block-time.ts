const MINUTE_S = 60;
const HOUR_S = 60 * MINUTE_S;
const DAY_S = 24 * HOUR_S;
/** Approximate calendar month for the relative/absolute cutoff. */
const MONTH_S = 30 * DAY_S;

/** Width of `YYYY-MM-DD HH:mm` — all time labels are padded to this. */
const WIDTH = 16;

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad(label: string): string {
  return label.padEnd(WIDTH);
}

/**
 * Human-readable block time for the tx list (fixed-width, left-aligned).
 * ≤ 1 month: relative (`just now` / `Nm ago` / `Nh ago` / `Nd ago`).
 * Older than 1 month: compact local `YYYY-MM-DD HH:mm`.
 */
export function formatBlockTimeLabel(
  unixSeconds: number,
  nowMs: number = Date.now(),
): string {
  const ageS = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (ageS <= MONTH_S) {
    if (ageS < MINUTE_S) return pad("just now");
    if (ageS < HOUR_S) return pad(`${Math.floor(ageS / MINUTE_S)}m ago`);
    if (ageS < DAY_S) return pad(`${Math.floor(ageS / HOUR_S)}h ago`);
    return pad(`${Math.floor(ageS / DAY_S)}d ago`);
  }
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Pad `#height` (and any other short fallback) to the time-column width. */
export function padBlockTimeLabel(label: string): string {
  return pad(label);
}
