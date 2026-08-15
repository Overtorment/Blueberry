import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";
import { closeFileLog, initFileLog } from "../../src/log.ts";

afterEach(() => {
  closeFileLog();
});

export function openTempFileLog(): { read(): string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "blueberry-log-"));
  const path = join(dir, "blueberry.log");
  initFileLog(path);
  return {
    read: () => readFileSync(path, "utf8"),
    close: () => {
      closeFileLog();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
