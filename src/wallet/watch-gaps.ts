import { config } from "../config.ts";
import {
  WATCH_EXTERNAL_KEY,
  WATCH_INTERNAL_KEY,
  type WatchGaps,
} from "./derive.ts";

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
    return Number.isFinite(n) && n >= 0 ? n : config.initialWatchCount;
  };
  const extRaw = db.keyValue.get(WATCH_EXTERNAL_KEY);
  const intRaw = db.keyValue.get(WATCH_INTERNAL_KEY);
  const external = parse(extRaw);
  const internal = parse(intRaw);
  if (extRaw === null || intRaw === null) {
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
    return idxs.some((i) => i >= start && i < n) ? n + gapLimit : n;
  };
  const external = bump(gaps.external, used.external);
  const internal = bump(gaps.internal, used.internal);
  return {
    gaps: { external, internal },
    grew: external !== gaps.external || internal !== gaps.internal,
  };
}
