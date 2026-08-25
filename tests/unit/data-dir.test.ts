import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  defaultDataDirIndex,
  ensureDataDir,
  listDataDirs,
  resolveDataDir,
} from "../../src/boot/data-dir.ts";

function withTempCwd(fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "blueberry-data-dir-"));
  try {
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("listDataDirs", () => {
  test("empty cwd is empty", () => {
    withTempCwd((cwd) => {
      expect(listDataDirs(cwd)).toEqual([]);
    });
  });

  test("lists only directories whose names end in .data", () => {
    withTempCwd((cwd) => {
      mkdirSync(join(cwd, "blueberry.data"));
      mkdirSync(join(cwd, "alice.data"));
      mkdirSync(join(cwd, "notes"));
      writeFileSync(join(cwd, "backup.data"), "");
      mkdirSync(join(cwd, "alice.data", "nested.data"));

      expect(listDataDirs(cwd)).toEqual(["alice.data", "blueberry.data"]);
    });
  });

  test("includes symlink directories and ignores dangling links", () => {
    withTempCwd((cwd) => {
      mkdirSync(join(cwd, "real-wallet"));
      symlinkSync(join(cwd, "real-wallet"), join(cwd, "blueberry.data"));
      symlinkSync(join(cwd, "missing"), join(cwd, "ghost.data"));
      mkdirSync(join(cwd, "alice.data"));

      expect(listDataDirs(cwd)).toEqual(["alice.data", "blueberry.data"]);
    });
  });
});

describe("resolveDataDir", () => {
  test("zero dirs uses blueberry.data", () => {
    expect(resolveDataDir([])).toEqual({
      action: "use",
      dir: "blueberry.data",
    });
  });

  test("one dir uses it", () => {
    expect(resolveDataDir(["alice.data"])).toEqual({
      action: "use",
      dir: "alice.data",
    });
  });

  test("several dirs require a pick", () => {
    expect(resolveDataDir(["alice.data", "blueberry.data"])).toEqual({
      action: "pick",
      dirs: ["alice.data", "blueberry.data"],
    });
  });
});

describe("defaultDataDirIndex", () => {
  test("highlights blueberry.data when present, else first", () => {
    expect(defaultDataDirIndex(["alice.data", "blueberry.data"])).toBe(1);
    expect(defaultDataDirIndex(["alice.data", "bob.data"])).toBe(0);
  });
});

describe("ensureDataDir", () => {
  test("creates a missing directory", () => {
    withTempCwd((cwd) => {
      const dir = join(cwd, "blueberry.data");
      ensureDataDir(dir);
      expect(listDataDirs(cwd)).toEqual(["blueberry.data"]);
    });
  });

  test("rejects a file occupying the data-dir name", () => {
    withTempCwd((cwd) => {
      const dir = join(cwd, "blueberry.data");
      writeFileSync(dir, "");
      expect(() => ensureDataDir(dir)).toThrow(/not a directory/);
    });
  });
});
