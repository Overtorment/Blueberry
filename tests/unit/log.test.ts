import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeFileLog,
  getLogPath,
  initFileLog,
  log,
  logError,
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
});
