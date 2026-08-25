import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DATA_DIR = "blueberry.data";

export type DataDirDecision =
  | { action: "use"; dir: string }
  | { action: "pick"; dirs: string[] };

/** Basenames of `*.data` directories in `cwd`, sorted. Files and nested dirs are ignored. */
export function listDataDirs(cwd: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (entry.name.endsWith(".data") && isDirectory(join(cwd, entry.name))) {
      names.push(entry.name);
    }
  }
  names.sort();
  return names;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveDataDir(dirs: readonly string[]): DataDirDecision {
  if (dirs.length === 0) {
    return { action: "use", dir: DEFAULT_DATA_DIR };
  }
  if (dirs.length === 1) {
    return { action: "use", dir: dirs[0]! };
  }
  return { action: "pick", dirs: [...dirs] };
}

export function defaultDataDirIndex(dirs: readonly string[]): number {
  const index = dirs.indexOf(DEFAULT_DATA_DIR);
  return index >= 0 ? index : 0;
}

/** Create `dir` if missing. Throws if the name is already a non-directory. */
export function ensureDataDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EEXIST" || code === "ENOTDIR") {
      throw new Error(`${dir} exists and is not a directory`);
    }
    throw err;
  }
}
