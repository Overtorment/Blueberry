import type { ByteDuplex } from "bip324";
import type { EventMap } from "../../bus/types.ts";
import type { Peer } from "../../db/types.ts";
import { getLogPath, log, logError } from "../../log.ts";
import { formatError } from "../../net/format-error.ts";
import { APP_NAME, APP_VERSION } from "../../net/user-agent.ts";
import type { Module, ModuleContext } from "../types.ts";
import { withTorDialRetries } from "./tor-dial-policy.ts";
import { createTorByteDuplexDialer } from "./tor-byte-duplex.ts";
import { broadcastTxV2, decodeBroadcastTx } from "./v2-broadcast.ts";

/** Bitcoin NODE_NETWORK — can serve the chain (and accept txs). */
const NODE_NETWORK = 1n;
/** Cap how many alive peers we materialize when picking a target. */
const ALIVE_PEER_PICK_LIMIT = 512;
const MAX_ATTEMPTS_DEFAULT = 20;
/** Full Tor dialer recycle cycles (meek + client). */
const DIALER_ATTEMPTS_DEFAULT = 3;

export type BroadcastModuleOptions = {
  /** Defaults to Tor exit dial via echalote. Injected in tests. */
  connect?: (
    host: string,
    port: number,
    signal: AbortSignal,
  ) => Promise<ByteDuplex>;
  disposeConnect?: () => Promise<void> | void;
  maxAttempts?: number;
  /** Outer Tor dialer cycles. Default 3. Ignored when `connect` is injected. */
  dialerAttempts?: number;
  peerWaitPollMs?: number;
  /** Tor dial + circuit + RELAY_BEGIN. Default 45s. */
  dialTimeoutMs?: number;
  /** BIP-324 handshake. Default 15s. */
  handshakeTimeoutMs?: number;
  ackTimeoutMs?: number;
  random?: () => number;
};

function abortedError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("cancelled");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortedError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortedError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function peerKey(p: { host: string; port: number }): string {
  return `${p.host}:${p.port}`;
}

function pickAlive(
  peers: Peer[],
  random: () => number,
): Peer | undefined {
  if (peers.length === 0) return undefined;
  return peers[Math.floor(random() * peers.length)];
}

export function createBroadcastModule(
  ctx: ModuleContext,
  options: BroadcastModuleOptions = {},
): Module {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS_DEFAULT;
  const dialerAttempts = options.dialerAttempts ?? DIALER_ATTEMPTS_DEFAULT;
  const peerWaitPollMs = options.peerWaitPollMs ?? 500;
  const dialTimeoutMs = options.dialTimeoutMs ?? 45_000;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
  const ackTimeoutMs = options.ackTimeoutMs ?? 15_000;
  const random = options.random ?? Math.random;
  const injectedConnect = options.connect;
  const injectedDispose = options.disposeConnect;

  let stopped = true;
  let unsubRequest: (() => void) | undefined;
  let unsubCancel: (() => void) | undefined;
  let activeId: string | null = null;
  let activeAbort: AbortController | null = null;
  let activeRun: Promise<void> | null = null;

  function alivePeers(limit: number): Peer[] {
    return ctx.db.peers.listAliveWithServices(NODE_NETWORK, limit);
  }

  async function waitForAlivePeers(signal: AbortSignal): Promise<void> {
    while (alivePeers(1).length === 0) {
      await sleep(peerWaitPollMs, signal);
    }
  }

  async function attemptOne(
    dial: NonNullable<BroadcastModuleOptions["connect"]>,
    peer: Peer,
    txHex: string,
    signal: AbortSignal,
  ): Promise<void> {
    const dialSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(dialTimeoutMs),
    ]);
    log("broadcast", `dial ${peerKey(peer)}`);
    const duplex = await dial(peer.host, peer.port, dialSignal);
    try {
      log("broadcast", `handshake ${peerKey(peer)}`);
      await broadcastTxV2(duplex, txHex, {
        port: peer.port,
        name: APP_NAME,
        version: APP_VERSION,
        handshakeTimeoutMs,
        ackTimeoutMs,
        signal,
      });
    } finally {
      try {
        await duplex.close();
      } catch {
        // ignore
      }
    }
  }

  async function runPeerAttempts(
    dial: NonNullable<BroadcastModuleOptions["connect"]>,
    txHex: string,
    signal: AbortSignal,
    emitProgress: (
      phase: EventMap["broadcast:progress"]["phase"],
      extra?: Partial<
        Omit<EventMap["broadcast:progress"], "id" | "phase" | "maxAttempts">
      >,
    ) => void,
  ): Promise<{ ok: true; peer: string } | { ok: false; failures: string[] }> {
    const failures: string[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal.aborted) throw abortedError(signal);
      const peer = pickAlive(alivePeers(ALIVE_PEER_PICK_LIMIT), random);
      if (!peer) break;
      const key = peerKey(peer);
      log("broadcast", `attempt ${attempt}/${maxAttempts} → ${key}`);
      emitProgress("attempt", { peer: key });

      try {
        await attemptOne(dial, peer, txHex, signal);
        log("broadcast", `success via ${key}`);
        return { ok: true, peer: key };
      } catch (err) {
        if (signal.aborted) throw abortedError(signal);
        const detail = formatError(err);
        failures.push(`${key}: ${detail}`);
        logError(
          "broadcast",
          `attempt ${attempt}/${maxAttempts} failed ${key}`,
          err,
        );
        emitProgress("failed-attempt", {
          peer: key,
          detail,
        });
      }
    }
    return { ok: false, failures };
  }

  async function runBroadcast(id: string, txHex: string): Promise<void> {
    const abort = new AbortController();
    activeId = id;
    activeAbort = abort;

    const attemptBudget = injectedConnect
      ? maxAttempts
      : maxAttempts * dialerAttempts;
    let attemptsUsed = 0;

    const emitProgress = (
      phase: EventMap["broadcast:progress"]["phase"],
      extra: Partial<
        Omit<EventMap["broadcast:progress"], "id" | "phase" | "maxAttempts">
      > = {},
    ) => {
      if (phase === "attempt") attemptsUsed += 1;
      const payload: EventMap["broadcast:progress"] = {
        id,
        phase,
        maxAttempts: attemptBudget,
        ...extra,
      };
      if (phase === "attempt" || phase === "failed-attempt") {
        payload.attempt = attemptsUsed;
      }
      ctx.bus.emit("broadcast:progress", payload);
    };

    try {
      decodeBroadcastTx(txHex);
      log(
        "broadcast",
        `start id=${id} txHexLen=${txHex.length} maxAttempts=${maxAttempts} dialerAttempts=${dialerAttempts}`,
      );
      emitProgress("waiting-peers");
      await waitForAlivePeers(abort.signal);

      let successPeer: string | null = null;
      let failures: string[] = [];

      if (injectedConnect) {
        const outcome = await runPeerAttempts(
          injectedConnect,
          txHex,
          abort.signal,
          emitProgress,
        );
        if (outcome.ok) successPeer = outcome.peer;
        else failures = outcome.failures;
      } else {
        try {
          successPeer = await withTorDialRetries(
            () => createTorByteDuplexDialer(),
            async (dial, signal) => {
              const outcome = await runPeerAttempts(
                dial as NonNullable<BroadcastModuleOptions["connect"]>,
                txHex,
                signal,
                emitProgress,
              );
              if (outcome.ok) return outcome.peer;
              throw new Error(
                outcome.failures.slice(-3).join(" | ") || "no alive peers",
              );
            },
            {
              attempts: dialerAttempts,
              signal: abort.signal,
            },
          );
        } catch (err) {
          if (abort.signal.aborted) throw err;
          failures = [formatError(err)];
        }
      }

      if (!successPeer) {
        const summary =
          failures.length > 0
            ? failures.slice(-3).join(" | ")
            : "no alive peers";
        const error =
          attemptsUsed > 0
            ? `broadcast failed after ${attemptsUsed} attempts: ${summary}`
            : `broadcast failed: ${summary}`;
        log("broadcast", error);
        const logHint = getLogPath() ? ` (see ${getLogPath()})` : "";
        ctx.bus.emit("broadcast:done", {
          id,
          ok: false,
          error: `${error}${logHint}`,
        });
        return;
      }

      log("broadcast", `done ok peer=${successPeer}`);
      ctx.bus.emit("broadcast:done", { id, ok: true, peer: successPeer });
    } catch (err) {
      const message = formatError(err);
      logError("broadcast", "aborted/error", err);
      emitProgress("error", { detail: message });
      const logHint = getLogPath() ? ` (see ${getLogPath()})` : "";
      ctx.bus.emit("broadcast:done", {
        id,
        ok: false,
        error: `${message}${logHint}`,
      });
    } finally {
      if (activeId === id) {
        activeId = null;
        activeAbort = null;
      }
    }
  }

  return {
    name: "broadcast",
    start() {
      stopped = false;
      ctx.bus.emit("module:status", {
        module: "broadcast",
        status: "running",
      });
      unsubRequest = ctx.bus.on("broadcast:request", ({ id, txHex }) => {
        if (stopped) return;
        if (activeId !== null) {
          ctx.bus.emit("broadcast:done", {
            id,
            ok: false,
            error: "broadcast already in progress",
          });
          return;
        }
        const run = runBroadcast(id, txHex);
        activeRun = run;
        void run.finally(() => {
          if (activeRun === run) activeRun = null;
        });
      });
      unsubCancel = ctx.bus.on("broadcast:cancel", ({ id }) => {
        if (activeId === id && activeAbort) {
          activeAbort.abort(new Error("cancelled"));
        }
      });
    },
    async stop() {
      stopped = true;
      unsubRequest?.();
      unsubCancel?.();
      unsubRequest = undefined;
      unsubCancel = undefined;
      if (activeAbort) activeAbort.abort(new Error("cancelled"));
      if (activeRun) {
        try {
          await activeRun;
        } catch {
          // ignore
        }
        activeRun = null;
      }
      await injectedDispose?.();
      ctx.bus.emit("module:status", {
        module: "broadcast",
        status: "stopped",
      });
    },
  };
}
