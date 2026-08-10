import {
  Networks,
  Protocol,
  answerPing,
  completeVersionHandshake,
  type ByteDuplex,
} from "bip324";
import {
  BIP157_SHORT_IDS,
  FILTER_TYPE_BASIC,
  decodeCFCheckpt,
  decodeCFHeaders,
  decodeCFilter,
  encodeOutbound,
} from "bip157";
import { config } from "../config.ts";
import type { TcpConnect } from "./types.ts";
import { APP_NAME, APP_VERSION } from "./user-agent.ts";

export type FilterSyncDuplex = ByteDuplex;

export type FilterBatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type FilterSyncOptions = {
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
  connect: TcpConnect;
  /** Test seam: full post-connect behavior. */
  runSession?: (
    duplex: FilterSyncDuplex,
    port: number,
  ) => Promise<FilterSessionApi>;
};

export type FilterSessionApi = {
  services: bigint;
  getCFCheckpt(stopHash: Uint8Array): Promise<Uint8Array[]>;
  getCFHeaders(
    startHeight: number,
    stopHash: Uint8Array,
  ): Promise<{
    filterType: number;
    stopHash: Uint8Array;
    previousFilterHeader: Uint8Array;
    filterHashes: Uint8Array[];
  }>;
  getCFilters(
    startHeight: number,
    stopHash: Uint8Array,
    expectCount: number,
    /** Called as each cfilter arrives (verify/save can overlap the rest of the download). */
    onFilter?: (filter: {
      blockHash: Uint8Array;
      filterBytes: Uint8Array;
    }) => void | Promise<void>,
  ): Promise<Array<{ blockHash: Uint8Array; filterBytes: Uint8Array }>>;
  close(): Promise<void> | void;
};

async function handshake(
  duplex: FilterSyncDuplex,
  port: number,
): Promise<{ protocol: Protocol; services: bigint }> {
  const protocol = await Protocol.connect(duplex, {
    role: "initiator",
    network: Networks.mainnet,
  });
  const { services } = await completeVersionHandshake(protocol, {
    port,
    name: APP_NAME,
    version: APP_VERSION,
  });
  return { protocol, services };
}

async function sendBip157(
  protocol: Protocol,
  msg: Parameters<typeof encodeOutbound>[0],
): Promise<void> {
  const encoded = encodeOutbound(msg);
  await protocol.writeMessage({
    command: "opaque",
    type: { kind: "short", id: encoded.shortId },
    payload: encoded.payload,
  });
}

async function waitForBip157Payload(
  protocol: Protocol,
  shortId: number,
  controller: AbortController,
): Promise<Uint8Array> {
  for (;;) {
    const message = await raceAbort(protocol.readMessage(), controller);
    if (
      message.command === "opaque" &&
      message.type.kind === "short" &&
      message.type.id === shortId
    ) {
      return message.payload;
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
): Promise<FilterSyncDuplex> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("connect aborted");
  }

  const pending = connect(host, port, signal);
  return await new Promise<FilterSyncDuplex>((resolve, reject) => {
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
    : new Error("filter sync aborted");
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

function wrapSessionClose(
  session: FilterSessionApi,
  duplex: FilterSyncDuplex,
  protocol?: Protocol,
): FilterSessionApi {
  return {
    ...session,
    close: async () => {
      await session.close();
      if (protocol !== undefined) {
        try {
          await protocol.close();
        } catch {
          await duplex.close();
        }
      } else {
        try {
          await duplex.close();
        } catch {
          // ignore
        }
      }
    },
  };
}

function createFilterSessionApi(
  protocol: Protocol,
  services: bigint,
  syncTimeoutMs: number,
  duplex: FilterSyncDuplex,
): FilterSessionApi {
  async function withSyncTimeout<T>(
    label: string,
    work: (controller: AbortController) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = armTimeout(controller, syncTimeoutMs, label);
    try {
      return await raceAbort(work(controller), controller);
    } finally {
      clearTimeout(timer);
    }
  }

  const session: FilterSessionApi = {
    services,
    getCFCheckpt: (stopHash) =>
      withSyncTimeout("cfcheckpt", async (controller) => {
        await sendBip157(protocol, {
          command: "getcfcheckpt",
          msg: { filterType: FILTER_TYPE_BASIC, stopHash },
        });
        const payload = await waitForBip157Payload(
          protocol,
          BIP157_SHORT_IDS.cfcheckpt,
          controller,
        );
        return decodeCFCheckpt(payload).filterHeaders;
      }),
    getCFHeaders: (startHeight, stopHash) =>
      withSyncTimeout("cfheaders", async (controller) => {
        await sendBip157(protocol, {
          command: "getcfheaders",
          msg: { filterType: FILTER_TYPE_BASIC, startHeight, stopHash },
        });
        const payload = await waitForBip157Payload(
          protocol,
          BIP157_SHORT_IDS.cfheaders,
          controller,
        );
        const decoded = decodeCFHeaders(payload);
        return {
          filterType: decoded.filterType,
          stopHash: decoded.stopHash,
          previousFilterHeader: decoded.previousFilterHeader,
          filterHashes: decoded.filterHashes,
        };
      }),
    getCFilters: (startHeight, stopHash, expectCount, onFilter) =>
      withSyncTimeout("cfilters", async (controller) => {
        await sendBip157(protocol, {
          command: "getcfilters",
          msg: { filterType: FILTER_TYPE_BASIC, startHeight, stopHash },
        });
        const filters: Array<{
          blockHash: Uint8Array;
          filterBytes: Uint8Array;
        }> = [];
        while (filters.length < expectCount) {
          const payload = await waitForBip157Payload(
            protocol,
            BIP157_SHORT_IDS.cfilter,
            controller,
          );
          const decoded = decodeCFilter(payload);
          const item = {
            blockHash: decoded.blockHash,
            filterBytes: decoded.filterBytes,
          };
          filters.push(item);
          if (onFilter) await onFilter(item);
        }
        return filters;
      }),
    close: async () => {
      try {
        await protocol.close();
      } catch {
        await duplex.close();
      }
    },
  };
  return session;
}

export async function openFilterSession(
  host: string,
  port: number,
  options: FilterSyncOptions,
): Promise<FilterBatchResult<FilterSessionApi>> {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? config.peerProbeTimeoutMs;
  const syncTimeoutMs = options.syncTimeoutMs ?? config.filterSyncTimeoutMs;
  const connect = options.connect;

  let duplex: FilterSyncDuplex | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let opened = false;

  try {
    timer = armTimeout(controller, connectTimeoutMs, "filter connect/handshake");
    duplex = await connectOrAbort(connect, host, port, controller.signal);

    if (options.runSession) {
      clearTimeout(timer);
      timer = undefined;
      const session = await options.runSession(duplex, port);
      opened = true;
      return {
        ok: true,
        value: wrapSessionClose(session, duplex),
      };
    }

    const { protocol, services } = await raceAbort(
      handshake(duplex, port),
      controller,
    );
    clearTimeout(timer);
    timer = undefined;
    opened = true;
    return {
      ok: true,
      value: createFilterSessionApi(protocol, services, syncTimeoutMs, duplex),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!opened) {
      try {
        await duplex?.close();
      } catch {
        // ignore close errors
      }
    }
  }
}
