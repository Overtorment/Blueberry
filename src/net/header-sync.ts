import {
  Networks,
  Protocol,
  answerPing,
  completeVersionHandshake,
  type BlockHeader,
  type ByteDuplex,
} from "bip324";
import { config } from "../config.ts";
import type { TcpConnect } from "./types.ts";
import { APP_NAME, APP_VERSION } from "./user-agent.ts";

export type HeaderSyncDuplex = ByteDuplex;

export type HeaderBatchResult =
  | {
      ok: true;
      startHeight: number;
      headers: BlockHeader[];
    }
  | { ok: false; error: string };

export type HeaderSyncOptions = {
  /** Connect + version handshake budget (skip dead peers quickly). */
  connectTimeoutMs?: number;
  /** getheaders → headers response budget after handshake. */
  headersTimeoutMs?: number;
  locatorHashes: Uint8Array[];
  stopHash?: Uint8Array;
  connect: TcpConnect;
  /**
   * Injected for tests: full post-connect session.
   * One-shot `fetchHeadersBatch` only; the session pool ignores this.
   */
  requestHeaders?: (
    duplex: HeaderSyncDuplex,
    port: number,
    locatorHashes: Uint8Array[],
    stopHash: Uint8Array,
  ) => Promise<{ startHeight: number; headers: BlockHeader[] }>;
};

export type HeaderSessionPoolOptions = {
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** Required unless `openSession` is provided. */
  connect?: TcpConnect;
  /**
   * Test seam: provide a ready session instead of TCP + BIP-324 handshake.
   * Production leaves this unset.
   */
  openSession?: (
    host: string,
    port: number,
  ) => Promise<{
    startHeight: number;
    requestHeaders: (
      locatorHashes: Uint8Array[],
      stopHash: Uint8Array,
    ) => Promise<{ startHeight: number; headers: BlockHeader[] }>;
    close: () => Promise<void> | void;
  }>;
  /** Fired when open socket count may have changed (live or connecting). */
  onOpenCount?: (open: number) => void;
};

const ZERO_HASH = new Uint8Array(32);

async function handshake(
  duplex: HeaderSyncDuplex,
  port: number,
): Promise<{ protocol: Protocol; startHeight: number }> {
  const protocol = await Protocol.connect(duplex, {
    role: "initiator",
    network: Networks.mainnet,
  });
  const { startHeight } = await completeVersionHandshake(protocol, {
    port,
    name: APP_NAME,
    version: APP_VERSION,
  });
  return { protocol, startHeight };
}

async function requestHeaderBatch(
  protocol: Protocol,
  startHeight: number,
  locatorHashes: Uint8Array[],
  stopHash: Uint8Array,
): Promise<{ startHeight: number; headers: BlockHeader[] }> {
  await protocol.writeMessage({
    command: "getheaders",
    payload: { version: 70_016, locatorHashes, stopHash },
  });

  for (;;) {
    const message = await protocol.readMessage();
    if (message.command === "headers") {
      return { startHeight, headers: message.payload.headers };
    }
    await answerPing(protocol, message);
  }
}

/** Connect, and close the duplex if the signal aborts before/during connect. */
async function connectOrAbort(
  connect: TcpConnect,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<HeaderSyncDuplex> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("connect aborted");
  }

  const pending = connect(host, port, signal);
  return await new Promise<HeaderSyncDuplex>((resolve, reject) => {
    const onAbort = () => {
      void pending
        .then((d) => Promise.resolve(d.close()).catch(() => {}))
        .catch(() => {});
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("connect aborted"),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (duplex) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          void Promise.resolve(duplex.close()).catch(() => {});
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("connect aborted"),
          );
          return;
        }
        resolve(duplex);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function armTimeout(
  controller: AbortController,
  ms: number,
  label: string,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timed out after ${ms}ms`));
  }, ms);
  timer.unref?.();
  return timer;
}

function abortError(controller: AbortController): Error {
  return controller.signal.reason instanceof Error
    ? controller.signal.reason
    : new Error("header sync aborted");
}

function raceAbort<T>(
  work: Promise<T>,
  controller: AbortController,
): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(abortError(controller));
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => reject(abortError(controller)),
        { once: true },
      );
    }),
  ]);
}

function peerKey(host: string, port: number): string {
  return `${host}:${port}`;
}

type LiveSession = {
  host: string;
  port: number;
  startHeight: number;
  busy: boolean;
  requestHeaders: (
    locatorHashes: Uint8Array[],
    stopHash: Uint8Array,
  ) => Promise<{ startHeight: number; headers: BlockHeader[] }>;
  close: () => Promise<void>;
};

export type HeaderSessionPool = {
  has(host: string, port: number): boolean;
  /** True when connecting/handshaking or a live session is mid-getheaders. */
  isBusy(host: string, port: number): boolean;
  fetchBatch(
    host: string,
    port: number,
    options: Pick<
      HeaderSyncOptions,
      "locatorHashes" | "stopHash" | "connectTimeoutMs" | "headersTimeoutMs"
    >,
  ): Promise<HeaderBatchResult>;
  drop(host: string, port: number): Promise<void>;
  closeAll(): Promise<void>;
};

/** Returned when a reused session is already downloading headers. */
export const SESSION_BUSY_ERROR = "session busy";

/** Persistent BIP-324 sessions: handshake once, reuse for many getheaders. */
export function createHeaderSessionPool(
  poolOptions: HeaderSessionPoolOptions = {},
): HeaderSessionPool {
  const defaultConnectTimeoutMs =
    poolOptions.connectTimeoutMs ?? config.peerProbeTimeoutMs;
  const defaultHeadersTimeoutMs =
    poolOptions.headersTimeoutMs ?? config.headerSyncTimeoutMs;
  const onOpenCount = poolOptions.onOpenCount;
  const connect = poolOptions.connect;
  const sessions = new Map<string, LiveSession>();
  /** Keys with connect/handshake in flight — not yet in `sessions`. */
  const connecting = new Set<string>();
  let opening = 0;
  let lastOpenCount = -1;
  let epoch = 0;

  function openCount(): number {
    return sessions.size + opening;
  }

  function notifyOpenCount(): void {
    if (!onOpenCount) return;
    const n = openCount();
    if (n === lastOpenCount) return;
    lastOpenCount = n;
    onOpenCount(n);
  }

  async function drop(host: string, port: number): Promise<void> {
    const key = peerKey(host, port);
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    notifyOpenCount();
    try {
      await session.close();
    } catch {
      // ignore
    }
  }

  async function openSession(
    host: string,
    port: number,
    connectTimeoutMs: number,
  ): Promise<LiveSession> {
    if (poolOptions.openSession) {
      const opened = await poolOptions.openSession(host, port);
      return {
        host,
        port,
        startHeight: opened.startHeight,
        busy: false,
        requestHeaders: opened.requestHeaders,
        close: async () => {
          await opened.close();
        },
      };
    }

    if (!connect) {
      throw new Error("HeaderSessionPool.connect required without openSession");
    }

    const controller = new AbortController();
    const timer = armTimeout(
      controller,
      connectTimeoutMs,
      "header connect/handshake",
    );
    let duplex: HeaderSyncDuplex | undefined;
    try {
      duplex = await connectOrAbort(
        connect,
        host,
        port,
        controller.signal,
      );
      const liveDuplex = duplex;
      const { protocol, startHeight } = await raceAbort(
        handshake(liveDuplex, port),
        controller,
      );
      return {
        host,
        port,
        startHeight,
        busy: false,
        requestHeaders: (locatorHashes, stopHash) =>
          requestHeaderBatch(protocol, startHeight, locatorHashes, stopHash),
        close: async () => {
          try {
            await protocol.close();
          } catch {
            await liveDuplex.close();
          }
        },
      };
    } catch (err) {
      if (duplex) {
        try {
          await duplex.close();
        } catch {
          // ignore
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    has(host, port) {
      const key = peerKey(host, port);
      return sessions.has(key) || connecting.has(key);
    },

    isBusy(host, port) {
      const key = peerKey(host, port);
      return sessions.get(key)?.busy === true || connecting.has(key);
    },

    async fetchBatch(host, port, options) {
      const key = peerKey(host, port);
      const connectTimeoutMs =
        options.connectTimeoutMs ?? defaultConnectTimeoutMs;
      const headersTimeoutMs =
        options.headersTimeoutMs ?? defaultHeadersTimeoutMs;
      const stopHash = options.stopHash ?? ZERO_HASH;

      let session = sessions.get(key);
      const started = epoch;
      try {
        if (!session) {
          if (connecting.has(key)) {
            return { ok: false, error: SESSION_BUSY_ERROR };
          }
          connecting.add(key);
          opening++;
          notifyOpenCount();
          try {
            session = await openSession(host, port, connectTimeoutMs);
            sessions.set(key, session);
            if (epoch !== started) {
              await drop(host, port);
              return { ok: false, error: "session closed" };
            }
          } finally {
            connecting.delete(key);
            opening--;
            notifyOpenCount();
          }
        }
        if (session.busy) {
          return { ok: false, error: SESSION_BUSY_ERROR };
        }
        session.busy = true;

        const controller = new AbortController();
        const timer = armTimeout(
          controller,
          headersTimeoutMs,
          "header download",
        );
        try {
          const result = await raceAbort(
            session.requestHeaders(options.locatorHashes, stopHash),
            controller,
          );
          return { ok: true, ...result };
        } finally {
          clearTimeout(timer);
          session.busy = false;
        }
      } catch (err) {
        await drop(host, port);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    drop,

    async closeAll() {
      epoch++;
      const open = [...sessions.values()];
      await Promise.all(open.map((session) => drop(session.host, session.port)));
      notifyOpenCount();
    },
  };
}

/**
 * One-shot fetch (connect → handshake → getheaders → close).
 * Prefer `createHeaderSessionPool` when syncing many batches.
 */
export async function fetchHeadersBatch(
  host: string,
  port: number,
  options: HeaderSyncOptions,
): Promise<HeaderBatchResult> {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? config.peerProbeTimeoutMs;
  const headersTimeoutMs =
    options.headersTimeoutMs ?? config.headerSyncTimeoutMs;
  const connect = options.connect;
  const stopHash = options.stopHash ?? ZERO_HASH;

  let duplex: HeaderSyncDuplex | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();

  try {
    timer = armTimeout(controller, connectTimeoutMs, "header connect/handshake");
    duplex = await connectOrAbort(connect, host, port, controller.signal);

    if (options.requestHeaders) {
      clearTimeout(timer);
      timer = armTimeout(controller, headersTimeoutMs, "header download");
      const result = await raceAbort(
        options.requestHeaders(duplex, port, options.locatorHashes, stopHash),
        controller,
      );
      return { ok: true, ...result };
    }

    const { protocol, startHeight } = await raceAbort(
      handshake(duplex, port),
      controller,
    );

    clearTimeout(timer);
    timer = armTimeout(controller, headersTimeoutMs, "header download");
    const result = await raceAbort(
      requestHeaderBatch(
        protocol,
        startHeight,
        options.locatorHashes,
        stopHash,
      ),
      controller,
    );
    return { ok: true, ...result };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await duplex?.close();
    } catch {
      // ignore close errors
    }
  }
}
