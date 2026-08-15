import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeFileLog,
  getLogPath,
  initFileLog,
  log,
  logError,
  shouldEnableFileLog,
} from "../../src/log.ts";

describe("file log", () => {
  let dir: string | null = null;

  afterEach(() => {
    closeFileLog();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  test("appends scoped lines", () => {
    dir = mkdtempSync(join(tmpdir(), "blueberry-log-"));
    const path = join(dir, "blueberry.log");
    initFileLog(path);
    expect(getLogPath()).toBe(path);

    log("broadcast", "hello");
    logError("tor", "boom", new Error("Errored", { cause: "reset" }));

    const text = readFileSync(path, "utf8");
    expect(text).toContain("[broadcast] hello");
    expect(text).toContain("[tor] boom: Errored ← reset");
  });

  test("shouldEnableFileLog is true only for an exact --log token", () => {
    expect(shouldEnableFileLog([])).toBe(false);
    expect(shouldEnableFileLog(["--logs"])).toBe(false);
    expect(shouldEnableFileLog(["--log=1"])).toBe(false);
    expect(shouldEnableFileLog(["--log"])).toBe(true);
    expect(shouldEnableFileLog(["bun", "src/main.tsx", "--log"])).toBe(true);
  });

  test("log is silent when the file is not opened", () => {
    dir = mkdtempSync(join(tmpdir(), "blueberry-log-"));
    const path = join(dir, "blueberry.log");
    expect(getLogPath()).toBeNull();
    log("main", "nope");
    logError("main", "nope", new Error("x"));
    expect(existsSync(path)).toBe(false);
  });
});
