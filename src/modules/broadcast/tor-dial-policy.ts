/**
 * Outer Tor dial cycles: create dialer → run work → dispose.
 * Recycles the whole meek/client stack between attempts.
 */
import { log, logError } from "../../log.ts";

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
    log("tor", `dialer-cycle start ${attempt}/${attempts}`);
    const dialer = createDialer();
    try {
      const result = await run(dialer.dial, signal);
      log("tor", `dialer-cycle ok ${attempt}/${attempts}`);
      return result;
    } catch (err) {
      lastError = err;
      if (signal.aborted) {
        logError("tor", `dialer-cycle abort ${attempt}/${attempts}`, err);
        throw signal.reason instanceof Error
          ? signal.reason
          : err instanceof Error
            ? err
            : new Error("cancelled");
      }
      logError("tor", `dialer-cycle fail ${attempt}/${attempts}`, err);
    } finally {
      try {
        await dialer.dispose();
      } catch (err) {
        logError("tor", `dialer-cycle dispose-fail ${attempt}/${attempts}`, err);
      }
      log("tor", `dialer-cycle dispose ${attempt}/${attempts}`);
    }
    if (attempt < attempts) {
      log(
        "tor",
        `dialer-cycle backoff ms=${backoffMs} next=${attempt + 1}/${attempts}`,
      );
      await sleep(backoffMs, signal);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("tor dial retries exhausted", { cause: lastError });
}
