import { config } from "../config.ts";
import {
  WATCH_EXTERNAL_KEY,
  WATCH_INTERNAL_KEY,
  type WatchGaps,
} from "./derive.ts";

const MAX_WATCH_COUNT = 10_000;

export function saveWatchGaps(
  db: { keyValue: { set(k: string, v: string): void } },
  gaps: WatchGaps,
): void {
  db.keyValue.set(WATCH_EXTERNAL_KEY, String(gaps.external));
  db.keyValue.set(WATCH_INTERNAL_KEY, String(gaps.internal));
}

export function loadWatchGaps(db: {
  keyValue: { get(k: string): string | null; set(k: string, v: string): void };
}): WatchGaps {
  const parse = (v: string | null) => {
    const n = v === null ? NaN : Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < 0) return config.initialWatchCount;
    return Math.min(Math.floor(n), MAX_WATCH_COUNT);
  };
  const extRaw = db.keyValue.get(WATCH_EXTERNAL_KEY);
  const intRaw = db.keyValue.get(WATCH_INTERNAL_KEY);
  const external = parse(extRaw);
  const internal = parse(intRaw);
  if (
    extRaw === null ||
    intRaw === null ||
    extRaw !== String(external) ||
    intRaw !== String(internal)
  ) {
    saveWatchGaps(db, { external, internal });
  }
  return { external, internal };
}

/** Pure: if any used index is in the last `gapLimit` of the window, grow by `gapLimit`. */
export function growWatchGapsIfNeeded(
  gaps: WatchGaps,
  used: { external: number[]; internal: number[] },
  gapLimit: number = config.gapLimit,
): { gaps: WatchGaps; grew: boolean } {
  const bump = (n: number, idxs: number[]) => {
    const start = n < gapLimit ? 0 : n - gapLimit;
    if (!idxs.some((i) => i >= start && i < n)) return n;
    return Math.min(n + gapLimit, MAX_WATCH_COUNT);
  };
  const external = bump(gaps.external, used.external);
  const internal = bump(gaps.internal, used.internal);
  return {
    gaps: { external, internal },
    grew: external !== gaps.external || internal !== gaps.internal,
  };
}
