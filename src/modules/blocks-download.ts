import {
  assertBlockPayload,
  encodeBlock,
  hexToBytes,
} from "bip324";
import { config } from "../config.ts";
import type { MatchedBlock } from "../db/types.ts";
import { internalHexToDisplayHex } from "../headers/hash.ts";
import { log as writeLog } from "../log.ts";
import {
  openBlockSession,
  type BlockSessionApi,
} from "../net/block-sync.ts";
import { formatError } from "../net/format-error.ts";
import type { PlatformNet } from "../net/types.ts";
import { detachLoop } from "./detach-loop.ts";
import type { Module, ModuleContext } from "./types.ts";

/** Bitcoin NODE_NETWORK — peer can serve historical blocks. */
const NODE_NETWORK = 1n;

const UI_MIN_MS = 100;
const PEER_COOL_MS = 3_000;
/** Poll while pending work remains but peers are scarce. */
const PEER_WAIT_MS = 1_000;

export type BlocksDownloadOptions = {
  net: PlatformNet;
  openSession?: typeof openBlockSession;
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
  concurrency?: number;
  idleDelayMs?: number;
  now?: () => number;
  /** Test seam: called when a download run starts. */
  onDownloadRun?: () => void;
  log?: (message: string) => void;
};

type PeerRef = { host: string; port: number };

function peerKey(peer: PeerRef): string {
  return `${peer.host}:${peer.port}`;
}

export function createBlocksDownloadModule(
  ctx: ModuleContext,
  options: BlocksDownloadOptions,
): Module {
  const openSession = options.openSession ?? openBlockSession;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? config.blockConnectTimeoutMs;
  const syncTimeoutMs = options.syncTimeoutMs ?? config.blockSyncTimeoutMs;
  const concurrency = Math.max(
    1,
    options.concurrency ?? config.blockConcurrency,
  );
  const idleDelayMs = Math.max(0, options.idleDelayMs ?? 500);
  const now = options.now ?? Date.now;
  const diagnosticLog =
    options.log ?? ((message: string) => writeLog("blocks-download", message));

  let stopped = true;
  let quiet = false;
  let unsubMatch: (() => void) | undefined;
  let unsubPeers: (() => void) | undefined;
  let unsubIdle: (() => void) | undefined;
  let unsubCatchup: (() => void) | undefined;
  let loopPromise: Promise<void> | undefined;
  let lastEmitAt = 0;
  let lastQueueDiagnostic = "";
  let attemptSequence = 0;

  const leasedPeers = new Set<string>();
  const peerCoolUntil = new Map<string, number>();
  const inFlight = new Map<number, Promise<void>>();
  /** Multiple waiters — Promise.race must not clobber a single shared wake. */
  const waiters = new Set<() => void>();

  function kick() {
    for (const wake of [...waiters]) wake();
  }

  function waitForKick(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      waiters.add(done);
    });
  }

  function emitProgress(force = false): void {
    const t = now();
    if (!force && t - lastEmitAt < UI_MIN_MS) return;
    lastEmitAt = t;
    ctx.bus.emit("blocks:progress", {
      at: t,
      downloaded: ctx.db.blocks.count(),
      matched: ctx.db.matchedBlocks.count(),
    });
  }

  function emitSockets(): void {
    ctx.bus.emit("peers:sockets", {
      at: now(),
      kind: "blk",
      open: inFlight.size,
    });
  }

  function pruneCooldowns(): void {
    const t = now();
    for (const [key, until] of peerCoolUntil) {
      if (until <= t) peerCoolUntil.delete(key);
    }
  }

  function leasePeer(): PeerRef | null {
    pruneCooldowns();
    // SQL-filter unused NODE_NETWORK peers — don't scan the full alive table.
    const candidates = ctx.db.peers
      .listAliveWithServices(NODE_NETWORK, 512, { unusedForBlocks: true })
      .filter((p) => {
        const key = peerKey(p);
        return !leasedPeers.has(key) && !peerCoolUntil.has(key);
      });
    if (candidates.length === 0) return null;
    // First remaining unused/unleased/uncooled peer. Cooldown already skips a
    // dead prefix of ORDER BY host, port — no extra cursor needed.
    const peer = {
      host: candidates[0]!.host,
      port: candidates[0]!.port,
    };
    leasedPeers.add(peerKey(peer));
    return peer;
  }

  function releasePeer(peer: PeerRef): void {
    leasedPeers.delete(peerKey(peer));
  }

  function coolPeer(peer: PeerRef): void {
    peerCoolUntil.set(peerKey(peer), now() + PEER_COOL_MS);
  }

  async function downloadOne(
    job: MatchedBlock,
    peer: PeerRef,
  ): Promise<boolean> {
    const startedAt = now();
    const attempt = ++attemptSequence;
    let session: BlockSessionApi | undefined;
    let phase = "session";
    try {
      diagnosticLog(`block start attempt=${attempt} peer=${peerKey(peer)}`);
      const opened = await openSession(peer.host, peer.port, {
        connect: options.net.connect,
        connectTimeoutMs,
        syncTimeoutMs,
      });
      if (!opened.ok) {
        coolPeer(peer);
        diagnosticLog(
          `session open failure attempt=${attempt} peer=${peerKey(peer)} elapsedMs=${Math.max(0, now() - startedAt)} cooldownMs=${PEER_COOL_MS} error=${formatError(opened.error)}`,
        );
        return false;
      }
      session = opened.value;
      phase = "download";
      const hashInternal = hexToBytes(job.blockHashInternalHex);
      const payload = await session.getBlock(hashInternal);
      phase = "validate";
      const hashDisplay = internalHexToDisplayHex(job.blockHashInternalHex);
      assertBlockPayload(payload, hashDisplay);
      const blockBytes = encodeBlock(payload);
      phase = "persist";
      // Reorg may have dropped/replaced this match while getBlock was in flight.
      const matched = ctx.db.matchedBlocks.get(job.height);
      if (
        !matched ||
        matched.blockHashInternalHex !== job.blockHashInternalHex
      ) {
        diagnosticLog(
          `block discarded stale attempt=${attempt} peer=${peerKey(peer)} height=${job.height} elapsedMs=${Math.max(0, now() - startedAt)}`,
        );
        return false;
      }
      const inserted = ctx.db.blocks.insert({
        height: job.height,
        blockHashInternalHex: job.blockHashInternalHex,
        block: blockBytes,
      });
      if (inserted) {
        ctx.db.peers.markUsedForBlocks(peer.host, peer.port);
        emitProgress(true);
      }
      diagnosticLog(
        `block success attempt=${attempt} peer=${peerKey(peer)} bytes=${blockBytes.length} elapsedMs=${Math.max(0, now() - startedAt)}`,
      );
      return inserted || ctx.db.blocks.has(job.height);
    } catch (err) {
      coolPeer(peer);
      diagnosticLog(
        `block failure attempt=${attempt} peer=${peerKey(peer)} phase=${phase} elapsedMs=${Math.max(0, now() - startedAt)} cooldownMs=${PEER_COOL_MS} error=${formatError(err)}`,
      );
      return false;
    } finally {
      if (session) {
        try {
          await session.close();
        } catch {
          // ignore
        }
      }
    }
  }

  function launch(job: MatchedBlock, peer: PeerRef): void {
    const task = (async () => {
      try {
        await downloadOne(job, peer);
      } finally {
        releasePeer(peer);
        inFlight.delete(job.height);
        emitSockets();
      }
    })();
    inFlight.set(job.height, task);
    emitSockets();
  }

  /**
   * Supervisor: keep filling free slots, wait for any completion,
   * never "finish a pass" while pending blocks remain.
   */
  async function loop(): Promise<void> {
    options.onDownloadRun?.();
    emitProgress(true);
    while (!stopped) {
      const pending = ctx.db.matchedBlocks
        .listNeedingDownload(concurrency)
        .filter((j) => !inFlight.has(j.height));

      if (pending.length === 0 && inFlight.size === 0) {
        lastQueueDiagnostic = "";
        // Idle: wake on filters:match / peers:updated, and poll DB periodically
        // so a missed kick cannot stall forever.
        await waitForKick(idleDelayMs);
        continue;
      }

      for (const job of pending) {
        if (stopped) break;
        if (inFlight.size >= concurrency) break;
        const peer = leasePeer();
        if (!peer) break;
        launch(job, peer);
      }

      if (inFlight.size === 0) {
        // Pending work but no usable peers right now.
        const message =
          `queue stalled pending=${pending.length} inFlight=0 ` +
          `leasedPeers=${leasedPeers.size} coolingPeers=${peerCoolUntil.size}`;
        if (message !== lastQueueDiagnostic) {
          diagnosticLog(message);
          lastQueueDiagnostic = message;
        }
        await waitForKick(PEER_WAIT_MS);
        continue;
      }

      lastQueueDiagnostic = "";
      // Wait for any in-flight download (or a kick) before refilling slots.
      await Promise.race([
        Promise.race([...inFlight.values()]),
        waitForKick(PEER_WAIT_MS),
      ]);
      emitProgress();
      // Instant session failures resolve inFlight via microtasks and can
      // starve timers; always yield a macrotask between busy iterations.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 0);
        t.unref?.();
      });
    }

    if (inFlight.size > 0) {
      await Promise.allSettled([...inFlight.values()]);
    }
  }

  return {
    name: "blocks-download",
    async start() {
      if (!stopped) return;
      stopped = false;
      diagnosticLog(
        `module start concurrency=${concurrency} connectTimeoutMs=${connectTimeoutMs} syncTimeoutMs=${syncTimeoutMs}`,
      );
      ctx.bus.emit("module:status", {
        module: "blocks-download",
        status: "starting",
      });
      emitProgress(true);
      unsubMatch = ctx.bus.on("filters:match", () => {
        kick();
      });
      unsubIdle = ctx.bus.on("sync:idle", () => {
        quiet = true;
      });
      unsubCatchup = ctx.bus.on("sync:catchup", () => {
        quiet = false;
        kick();
      });
      unsubPeers = ctx.bus.on("peers:updated", () => {
        if (quiet) return;
        kick();
      });
      loopPromise = detachLoop(ctx, "blocks-download", loop());
      ctx.bus.emit("module:status", {
        module: "blocks-download",
        status: "running",
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubMatch?.();
      unsubMatch = undefined;
      unsubIdle?.();
      unsubIdle = undefined;
      unsubCatchup?.();
      unsubCatchup = undefined;
      unsubPeers?.();
      unsubPeers = undefined;
      kick();
      await loopPromise;
      loopPromise = undefined;
      emitSockets();
      ctx.bus.emit("module:status", {
        module: "blocks-download",
        status: "stopped",
      });
      diagnosticLog("module stopped");
    },
  };
}
