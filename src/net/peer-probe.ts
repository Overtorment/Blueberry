import {
  Networks,
  Protocol,
  completeVersionHandshake,
  type ByteDuplex,
} from "bip324";
import { config } from "../config.ts";
import type { PeerCandidate } from "./dns-seeds.ts";
import type { TcpConnect } from "./types.ts";
import { APP_NAME, APP_VERSION } from "./user-agent.ts";

export type ProbeDuplex = ByteDuplex;

export type HandshakeResult = {
  peers: PeerCandidate[];
  services: bigint;
};

export type ProbeResult =
  | { ok: true; peers: PeerCandidate[]; services: bigint }
  | { ok: false; error: string };

export type ProbeOptions = {
  timeoutMs?: number;
  connect: TcpConnect;
  handshakeAndGetAddr?: (
    duplex: ProbeDuplex,
    port: number,
  ) => Promise<HandshakeResult>;
};

/**
 * After version/verack the peer is usable for sync (services come from version).
 * Do not wait on getaddr — it often never arrives before the probe timeout, which
 * aborted the whole handshake and cleared alive while TCP was already ESTAB.
 */
async function defaultHandshakeAndGetAddr(
  duplex: ProbeDuplex,
  port: number,
): Promise<HandshakeResult> {
  const protocol = await Protocol.connect(duplex, {
    role: "initiator",
    network: Networks.mainnet,
  });
  const { services } = await completeVersionHandshake(protocol, {
    port,
    name: APP_NAME,
    version: APP_VERSION,
  });
  return { peers: [], services };
}

/** Connect, and close the duplex if the signal aborts before/during connect. */
async function connectOrAbort(
  connect: TcpConnect,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<ProbeDuplex> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("connect aborted");
  }

  const pending = connect(host, port, signal);
  return await new Promise<ProbeDuplex>((resolve, reject) => {
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

export async function probePeer(
  host: string,
  port: number,
  options: ProbeOptions,
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? config.peerProbeTimeoutMs;
  const controller = new AbortController();
  const connect = options.connect;
  const handshakeAndGetAddr =
    options.handshakeAndGetAddr ?? defaultHandshakeAndGetAddr;

  let duplex: ProbeDuplex | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    timer = setTimeout(() => {
      controller.abort(new Error(`probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    duplex = await connectOrAbort(connect, host, port, controller.signal);

    const abortError = () =>
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new Error("probe aborted");

    const { peers, services } = await Promise.race([
      handshakeAndGetAddr(duplex, port),
      new Promise<never>((_, reject) => {
        if (controller.signal.aborted) {
          reject(abortError());
          return;
        }
        controller.signal.addEventListener(
          "abort",
          () => reject(abortError()),
          { once: true },
        );
      }),
    ]);
    return { ok: true, peers, services };
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
