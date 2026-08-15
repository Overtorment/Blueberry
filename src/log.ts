import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatError } from "./net/format-error.ts";

let logPath: string | null = null;

/** True only when argv contains the exact token `--log`. */
export function shouldEnableFileLog(argv: readonly string[]): boolean {
  return argv.includes("--log");
}

/** Enable append-only logging to `filePath` (created if missing). */
export function initFileLog(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  logPath = filePath;
  writeRaw(`\n======== blueberry ${new Date().toISOString()} ========\n`);
}

/** Disable file logging (tests). */
export function closeFileLog(): void {
  logPath = null;
}

export function getLogPath(): string | null {
  return logPath;
}

function writeRaw(line: string): void {
  if (!logPath) return;
  try {
    appendFileSync(logPath, line, "utf8");
  } catch {
    // never let logging break the app
  }
}

/** Timestamped line: `ISO [scope] message` */
export function log(scope: string, message: string): void {
  writeRaw(`${new Date().toISOString()} [${scope}] ${message}\n`);
}

/** Like `log`, optionally appending a formatted error chain. */
export function logError(scope: string, message: string, err?: unknown): void {
  if (err === undefined) {
    log(scope, message);
    return;
  }
  log(scope, `${message}: ${formatError(err)}`);
}
