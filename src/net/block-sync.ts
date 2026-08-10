import {
  Networks,
  Protocol,
  answerPing,
  completeVersionHandshake,
  equalBytes,
  type BlockPayload,
  type ByteDuplex,
} from "bip324";
import { config } from "../config.ts";
import type { TcpConnect } from "./types.ts";
import { APP_NAME, APP_VERSION } from "./user-agent.ts";

/** Inventory type for a full block without witness data (Bitcoin Core MSG_BLOCK). */
export const MSG_BLOCK = 2;
/** BIP144: full block including witness data (MSG_BLOCK | MSG_WITNESS_FLAG). */
export const MSG_WITNESS_BLOCK = MSG_BLOCK | (1 << 30);

export type BlockSyncDuplex = ByteDuplex;

export type BlockBatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type BlockSyncOptions = {
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
  connect: TcpConnect;
  /** Test seam: full post-connect behavior. */
  runSession?: (
    duplex: BlockSyncDuplex,
    port: number,
  ) => Promise<BlockSessionApi>;
};

export type BlockSessionApi = {
  services: bigint;
  getBlock(hashInternal: Uint8Array): Promise<BlockPayload>;
  close(): Promise<void> | void;
};

async function handshake(
  duplex: BlockSyncDuplex,
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

/** Connect, and close the duplex if the signal aborts before/during connect. */
async function connectOrAbort(
  connect: TcpConnect,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<BlockSyncDuplex> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("connect aborted");
  }

  const pending = connect(host, port, signal);
  return await new Promise<BlockSyncDuplex>((resolve, reject) => {
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
    : new Error("block sync aborted");
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
  session: BlockSessionApi,
  duplex: BlockSyncDuplex,
  protocol?: Protocol,
): BlockSessionApi {
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

function createBlockSessionApi(
  protocol: Protocol,
  services: bigint,
  syncTimeoutMs: number,
  duplex: BlockSyncDuplex,
): BlockSessionApi {
  async function closeQuietly(): Promise<void> {
    try {
      await protocol.close();
    } catch {
      try {
        await duplex.close();
      } catch {
        // ignore
      }
    }
  }

  async function withSyncTimeout<T>(
    label: string,
    work: (controller: AbortController) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = armTimeout(controller, syncTimeoutMs, label);
    // Abort must tear down the socket — otherwise readMessage stays pending
    // and fds accumulate in CLOSE-WAIT under concurrent downloads.
    const onAbort = () => {
      void closeQuietly();
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await raceAbort(work(controller), controller);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    }
  }

  const session: BlockSessionApi = {
    services,
    getBlock: (hashInternal) =>
      withSyncTimeout("getdata/block", async (controller) => {
        await protocol.writeMessage({
          command: "getdata",
          payload: {
            inventory: [{ type: MSG_WITNESS_BLOCK, hash: hashInternal }],
          },
        });
        for (;;) {
          const message = await raceAbort(protocol.readMessage(), controller);
          if (message.command === "block") {
            return message.payload;
          }
          if (message.command === "notfound") {
            const containsRequested = message.payload.inventory.some(
              (item) =>
                (item.type === MSG_WITNESS_BLOCK || item.type === MSG_BLOCK) &&
                equalBytes(item.hash, hashInternal),
            );
            if (!containsRequested) {
              throw new Error("notfound did not contain requested block");
            }
            throw new Error("notfound block");
          }
          await answerPing(protocol, message);
        }
      }),
    close: () => closeQuietly(),
  };
  return session;
}

export async function openBlockSession(
  host: string,
  port: number,
  options: BlockSyncOptions,
): Promise<BlockBatchResult<BlockSessionApi>> {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? config.blockConnectTimeoutMs;
  const syncTimeoutMs =
    options.syncTimeoutMs ?? config.blockSyncTimeoutMs;
  const connect = options.connect;

  let duplex: BlockSyncDuplex | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let opened = false;

  try {
    timer = armTimeout(
      controller,
      connectTimeoutMs,
      "block connect/handshake",
    );
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
      value: createBlockSessionApi(protocol, services, syncTimeoutMs, duplex),
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
