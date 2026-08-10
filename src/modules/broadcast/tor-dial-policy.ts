/**
 * Outer Tor dial cycles: create dialer → run work → dispose.
 * Recycles the whole meek/client stack between attempts.
 */

export type TorDialerHandle = {
  dial: (
    host: string,
    port: number,
    signal: AbortSignal,
  ) => Promise<unknown>;
  dispose: () => Promise<void> | void;
};

export type TorDialRetryOptions = {
  /** Full dialer cycles. Default 3. */
  attempts?: number;
  /** Pause between failed cycles. Default 1500ms. */
  backoffMs?: number;
  signal: AbortSignal;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("cancelled"),
      );
      return;
    }
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("cancelled"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withTorDialRetries<T>(
  createDialer: () => TorDialerHandle,
  run: (
    dial: TorDialerHandle["dial"],
    signal: AbortSignal,
  ) => Promise<T>,
  options: TorDialRetryOptions,
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 1_500;
  const { signal } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("cancelled");
    }
    const dialer = createDialer();
    try {
      return await run(dialer.dial, signal);
    } catch (err) {
      lastError = err;
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : err instanceof Error
            ? err
            : new Error("cancelled");
      }
    } finally {
      try {
        await dialer.dispose();
      } catch {
        // ignore
      }
    }
    if (attempt < attempts) {
      await sleep(backoffMs, signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("tor dial retries exhausted", { cause: lastError });
}
