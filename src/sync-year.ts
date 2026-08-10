import { CHECKPOINTS } from "./checkpoint.ts";

export const SYNC_FROM_YEAR_KEY = "sync_from_year";

type Kv = {
  keyValue: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
};

export function listCheckpointYears(): number[] {
  return Object.keys(CHECKPOINTS)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Newest year in `CHECKPOINTS` — used when creating a brand-new wallet. */
export function latestCheckpointYear(): number {
  const years = listCheckpointYears();
  const year = years[years.length - 1];
  if (year === undefined) throw new Error("no checkpoints configured");
  return year;
}

export function parseSyncFromYear(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const year = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(year) || String(year) !== trimmed) return null;
  if (!(year in CHECKPOINTS)) return null;
  return year;
}

export type SyncFromYearInspection =
  | { status: "missing" }
  | { status: "ok"; year: number };

export function inspectSyncFromYear(db: Kv): SyncFromYearInspection {
  const year = parseSyncFromYear(db.keyValue.get(SYNC_FROM_YEAR_KEY));
  if (year === null) return { status: "missing" };
  return { status: "ok", year };
}

export function loadSyncFromYear(db: Kv): number {
  const inspected = inspectSyncFromYear(db);
  if (inspected.status !== "ok") {
    throw new Error("sync_from_year missing or invalid");
  }
  return inspected.year;
}

export function saveSyncFromYear(db: Kv, year: number): void {
  if (!(year in CHECKPOINTS)) {
    throw new Error(`unknown sync_from_year: ${year}`);
  }
  db.keyValue.set(SYNC_FROM_YEAR_KEY, String(year));
}
