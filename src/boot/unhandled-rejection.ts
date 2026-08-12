type ProcessLike = {
  on(
    event: "unhandledRejection",
    handler: (reason: unknown) => void,
  ): unknown;
};

/**
 * Log unhandled rejections and exit. Bun's default exits 1; installing any
 * listener suppresses that, so we must exit explicitly.
 */
export function installFatalUnhandledRejection(options: {
  onRejection: (reason: unknown) => void;
  exit: (code: number) => void;
  process?: ProcessLike;
}): void {
  const proc = options.process ?? process;
  proc.on("unhandledRejection", (reason) => {
    options.onRejection(reason);
    options.exit(1);
  });
}
