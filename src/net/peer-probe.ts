import {
  Networks,
  Protocol,
  answerPing,
  completeVersionHandshake,
  type ByteDuplex,
  type Message,
} from "bip324";
import { config } from "../config.ts";
import { addrV2ToCandidate, legacyAddrToCandidate } from "./addr.ts";
import type { PeerCandidate } from "./dns-seeds.ts";
import type { TcpConnect } from "./types.ts";
import { APP_NAME, APP_VERSION } from "./user-agent.ts";

const MAX_CRAWL_ADDRS = 1_000;

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
  addrTimeoutMs?: number;
  wantAddr?: boolean;
  connect: TcpConnect;
  /** Test hook. When set, skips the real handshake and the getaddr phase. */
  handshakeAndGetAddr?: (
    duplex: ProbeDuplex,
    port: number,
  ) => Promise<HandshakeResult>;
};

/** Version/verack only. Address collection is a later, optional phase. */
async function defaultHandshake(
  duplex: ProbeDuplex,
  port: number,
): Promise<{ services: bigint; protocol: Protocol }> {
  const protocol = await Protocol.connect(duplex, {
    role: "initiator",
    network: Networks.mainnet,
  });
  const { services } = await completeVersionHandshake(protocol, {
    port,
    name: APP_NAME,
    version: APP_VERSION,
  });
  return { services, protocol };
}

function peersFromAddrMessage(message: Message, limit: number): {
  peers: PeerCandidate[];
  rawCount: number;
} | undefined {
  if (message.command === "addrv2") {
    const rows = message.payload.addresses;
    return {
      rawCount: rows.length,
      peers: rows
        .slice(0, limit)
        .map(addrV2ToCandidate)
        .filter((p): p is PeerCandidate => p !== undefined),
    };
  }
  if (message.command === "addr") {
    const rows = message.payload.addresses;
    return {
      rawCount: rows.length,
      peers: rows
        .slice(0, limit)
        .map(legacyAddrToCandidate)
        .filter((p): p is PeerCandidate => p !== undefined),
    };
  }
  return undefined;
}

/**
 * Race `work` against the remaining addr budget.
 * Keep the rejection handler after timeout and clear the timer on completion.
 */
function raceDeadline<T>(
  work: Promise<T>,
  deadline: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const ms = deadline - Date.now();
  if (ms <= 0) {
    void work.catch(() => {});
    return Promise.resolve({ ok: false });
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ ok: false });
    }, ms);
    timer.unref?.();
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** getaddr + addr/addrv2. Timeouts and errors return whatever was collected. */
async function collectAddrAfterHandshake(
  protocol: Protocol,
  addrTimeoutMs: number,
): Promise<PeerCandidate[]> {
  const collected: PeerCandidate[] = [];
  let seen = 0;
  const deadline = Date.now() + addrTimeoutMs;
  try {
    const wrote = await raceDeadline(
      protocol.writeMessage({ command: "getaddr" }),
      deadline,
    );
    if (!wrote.ok) return collected;

    for (;;) {
      const got = await raceDeadline(protocol.readMessage(), deadline);
      if (!got.ok) break;
      const parsed = peersFromAddrMessage(
        got.value,
        MAX_CRAWL_ADDRS - seen,
      );
      if (parsed) {
        seen += Math.min(parsed.rawCount, MAX_CRAWL_ADDRS - seen);
        collected.push(...parsed.peers);
        if (parsed.rawCount >= 2 || seen >= MAX_CRAWL_ADDRS) break;
      } else {
        const answered = await raceDeadline(
          answerPing(protocol, got.value),
          deadline,
        );
        if (!answered.ok) break;
      }
    }
  } catch {
    // write/read/close: keep what we have
  }
  return collected;
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
  const addrTimeoutMs = options.addrTimeoutMs ?? config.peerAddrTimeoutMs;
  const wantAddr = options.wantAddr === true;
  const controller = new AbortController();
  const connect = options.connect;

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

    const abortPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(abortError());
        return;
      }
      controller.signal.addEventListener(
        "abort",
        () => reject(abortError()),
        { once: true },
      );
    });

    // Injected handshake is tests-only and never starts a getaddr phase.
    if (options.handshakeAndGetAddr) {
      const { peers, services } = await Promise.race([
        options.handshakeAndGetAddr(duplex, port),
        abortPromise,
      ]);
      return { ok: true, peers, services };
    }

    const handshake = defaultHandshake(duplex, port);
    void handshake.catch(() => {});
    const { services, protocol } = await Promise.race([
      handshake,
      abortPromise,
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const peers = wantAddr
      ? await collectAddrAfterHandshake(protocol, addrTimeoutMs)
      : [];
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
