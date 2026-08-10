/**
 * Soft-re-exec this process so boot matches a cold start.
 * Parent waits for the child (stdio inherited) then exits with the child code.
 */
export function reexecSelf(): never {
  const cmd = process.execPath;
  const args = process.argv.slice(1);
  try {
    const result = Bun.spawnSync([cmd, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.reallyExit(result.exitCode ?? 1);
  } catch (err) {
    console.error(
      "failed to re-exec:",
      err instanceof Error ? err.message : String(err),
    );
    process.reallyExit(1);
  }
}
