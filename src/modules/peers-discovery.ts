import { Networks } from "bip324";
import { NODE_COMPACT_FILTERS } from "bip157";
import { config } from "../config.ts";
import {
  MAINNET_DNS_SEEDS,
  resolveSeedPeers,
  type PeerCandidate,
} from "../net/dns-seeds.ts";
import { probePeer, type ProbeResult } from "../net/peer-probe.ts";
import type { PlatformNet } from "../net/types.ts";
import { detachLoop } from "./detach-loop.ts";
import type { Module, ModuleContext } from "./types.ts";

export type PeersDiscoveryOptions = {
  net: PlatformNet;
  resolveSeeds?: () => Promise<PeerCandidate[]>;
  probe?: (host: string, port: number) => Promise<ProbeResult>;
  concurrency?: number;
  /** How long to wait when there is nothing to probe. */
  idleDelayMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
  /** Re-resolve DNS seeds when alive compact-filter peers drop below this. */
  minAliveCompactFilters?: number;
  /** Minimum interval between DNS re-seeds. */
  reseedIntervalMs?: number;
};

function pickNext(
  peers: { host: string; port: number; lastProbedAt: number | null }[],
  inflight: Set<string>,
) {
  return peers.find((p) => !inflight.has(`${p.host}:${p.port}`));
}

export function createPeersDiscoveryModule(
  ctx: ModuleContext,
  options: PeersDiscoveryOptions,
): Module {
  const port = Networks.mainnet.defaultPort;
  const resolveSeeds =
    options.resolveSeeds ??
    (() =>
      resolveSeedPeers(MAINNET_DNS_SEEDS, {
        port,
        resolver: options.net.dns,
      }));
  const probeTimeoutMs = options.probeTimeoutMs ?? config.peerProbeTimeoutMs;
  const probe =
    options.probe ??
    ((host, p) =>
      probePeer(host, p, {
        timeoutMs: probeTimeoutMs,
        connect: options.net.connect,
      }));
  const concurrency = options.concurrency ?? config.peerConcurrency;
  const idleDelayMs = options.idleDelayMs ?? 500;
  const now = options.now ?? Date.now;
  const minAliveCompactFilters = options.minAliveCompactFilters ?? 16;
  const reseedIntervalMs = options.reseedIntervalMs ?? 60_000;

  let stopped = true;
  let paused = false;
  let unsubIdle: (() => void) | undefined;
  let unsubCatchup: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let lastReseedAt = 0;
  const inflight = new Set<string>();

  function kick() {
    wake?.();
  }

  function emitUpdated() {
    ctx.bus.emit("peers:updated", { at: now() });
  }

  function emitSockets(): void {
    ctx.bus.emit("peers:sockets", {
      at: now(),
      kind: "probe",
      open: inflight.size,
    });
  }

  function upsertCandidate(candidate: PeerCandidate): void {
    ctx.db.peers.upsert({
      host: candidate.host,
      port: candidate.port,
      services: candidate.services,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
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
        if (wake === done) wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      wake = done;
    });
  }

  async function bootstrap(): Promise<void> {
    if (ctx.db.peers.listAlive().length > 0) return;
    const seeds = await resolveSeeds();
    if (stopped) return;
    for (const candidate of seeds) upsertCandidate(candidate);
    if (seeds.length > 0) emitUpdated();
  }

  function aliveCompactFilterCount(): number {
    // Cap the scan — we only need "enough" for the reseed threshold.
    return ctx.db.peers.listAliveWithServices(
      BigInt(NODE_COMPACT_FILTERS),
      minAliveCompactFilters,
    ).length;
  }

  /** When the alive CF pool is thin, pull fresh DNS seed candidates. */
  async function maybeReseed(): Promise<void> {
    const t = now();
    if (t - lastReseedAt < reseedIntervalMs) return;
    if (aliveCompactFilterCount() >= minAliveCompactFilters) return;
    lastReseedAt = t;
    try {
      const seeds = await resolveSeeds();
      if (stopped) return;
      for (const candidate of seeds) upsertCandidate(candidate);
      if (seeds.length > 0) emitUpdated();
    } catch {
      // ignore DNS failures; probe loop continues
    }
  }

  async function runLoop(): Promise<void> {
    while (!stopped) {
      if (paused) {
        await waitForKick(60_000);
        continue;
      }
      await maybeReseed();
      let spawned = 0;
      while (!stopped && !paused && inflight.size < concurrency) {
        // Prefer known compact-filter peers when that pool is empty — otherwise
        // the generic queue burns slots on peers that can't serve filters/blocks.
        const needCf = aliveCompactFilterCount() < minAliveCompactFilters;
        const cfCandidates = needCf
          ? ctx.db.peers
              .listWithServices(
                BigInt(NODE_COMPACT_FILTERS),
                concurrency + inflight.size + 32,
              )
              .filter((p) => !p.alive)
          : [];
        const next =
          pickNext(cfCandidates, inflight) ??
          pickNext(
            ctx.db.peers.listProbeQueue(concurrency + inflight.size + 16),
            inflight,
          );
        if (!next) break;
        const key = `${next.host}:${next.port}`;
        inflight.add(key);
        emitSockets();
        spawned++;
        void (async () => {
          try {
            const result = await probe(next.host, next.port);
            // markProbed / markAlive / new upserts all mutate peer rows.
            ctx.db.peers.markProbed(next.host, next.port, now());
            if (result.ok) {
              ctx.db.peers.upsert({
                host: next.host,
                port: next.port,
                services: result.services,
                alive: true,
                usedForBlocks: false,
                lastProbedAt: now(),
              });
              for (const peer of result.peers) upsertCandidate(peer);
              ctx.db.peers.markAlive(next.host, next.port, true);
            } else {
              // Stale "alive" entries block filter/header sync peer pools.
              ctx.db.peers.markAlive(next.host, next.port, false);
            }
            emitUpdated();
          } catch {
            ctx.db.peers.markProbed(next.host, next.port, now());
            ctx.db.peers.markAlive(next.host, next.port, false);
            emitUpdated();
          } finally {
            inflight.delete(key);
            emitSockets();
            kick(); // refill a slot immediately
          }
        })();
      }

      if (stopped) break;

      // Slots full or no candidates: wait for a probe to finish, or idle briefly.
      if (inflight.size >= concurrency || spawned === 0) {
        await waitForKick(inflight.size > 0 ? probeTimeoutMs : idleDelayMs);
      } else {
        await waitForKick(1);
      }
      // Instant probe failures wake waitForKick via microtasks and can starve
      // timers; always yield a macrotask between loop iterations.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 0);
        t.unref?.();
      });
    }
    // Do not drain in-flight probes — shutdown ignores open connections.
  }

  return {
    name: "peers-discovery",
    async start() {
      if (!stopped) return;
      ctx.bus.emit("module:status", {
        module: "peers-discovery",
        status: "starting",
      });
      stopped = false;
      unsubIdle = ctx.bus.on("sync:idle", () => {
        paused = true;
        kick();
      });
      unsubCatchup = ctx.bus.on("sync:catchup", () => {
        paused = false;
        kick();
      });
      // Grace period so startup doesn't DNS-reseed on top of bootstrap.
      lastReseedAt = now();
      // Don't await DNS bootstrap — it blocks the whole module start chain
      // (and filters-matching) when the peer table is empty.
      void bootstrap()
        .then(() => {
          if (!stopped) void detachLoop(ctx, "peers-discovery", runLoop());
        })
        .catch(() => {
          if (!stopped) void detachLoop(ctx, "peers-discovery", runLoop());
        });
      ctx.bus.emit("module:status", {
        module: "peers-discovery",
        status: "running",
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      unsubIdle?.();
      unsubCatchup?.();
      paused = false;
      kick();
      // Shutdown ignores in-flight probes; report zero open for the TUI.
      inflight.clear();
      emitSockets();
      ctx.bus.emit("module:status", {
        module: "peers-discovery",
        status: "stopped",
      });
    },
  };
}
