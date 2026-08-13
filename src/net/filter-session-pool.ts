import { config } from "../config.ts";
import {
  openFilterSession,
  type FilterSessionApi,
} from "./filter-sync.ts";
import { formatError } from "./format-error.ts";
import type { TcpConnect } from "./types.ts";

export type FilterPoolPeer = { host: string; port: number };

export type FilterSessionPoolOptions = {
  connect: TcpConnect;
  openSession?: typeof openFilterSession;
  max?: number;
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
  /** Cooldown after a failed lease (ms). */
  coolMs?: number;
  now?: () => number;
  /** Fired when open socket count may have changed (session or connecting). */
  onOpenCount?: (open: number) => void;
  /** Optional batch-sync diagnostics sink. */
  onDiagnostic?: (message: string) => void;
};

type Endpoint = {
  peer: FilterPoolPeer;
  session: FilterSessionApi | null;
  busy: boolean;
  coolUntil: number;
  /** Dropped from peerOrder while busy; close when lease ends. */
  orphaned: boolean;
};

function peerKey(host: string, port: number): string {
  return `${host}:${port}`;
}

/**
 * Persistent BIP-324 filter sessions: handshake once, reuse across batches,
 * cool failing endpoints instead of hammering them.
 */
export function createFilterSessionPool(options: FilterSessionPoolOptions) {
  const { connect } = options;
  const openSession =
    options.openSession ??
    ((host, port, opts) =>
      openFilterSession(host, port, { ...opts, connect }));
  const max = Math.max(1, options.max ?? config.filterConcurrency);
  const connectTimeoutMs =
    options.connectTimeoutMs ?? config.peerProbeTimeoutMs;
  const syncTimeoutMs =
    options.syncTimeoutMs ?? config.filterSyncTimeoutMs;
  const coolMs = options.coolMs ?? 30_000;
  const now = options.now ?? Date.now;
  const onOpenCount = options.onOpenCount;
  const onDiagnostic = options.onDiagnostic;

  const endpoints = new Map<string, Endpoint>();
  let peerOrder: string[] = [];
  let cursor = 0;
  let lastOpenCount = -1;
  let generation = 0;

  function openCount(): number {
    let n = 0;
    for (const ep of endpoints.values()) {
      // Busy (connecting/leased) or holding a live session = open FD.
      if (ep.session || ep.busy) n++;
    }
    return n;
  }

  function notifyOpenCount(): void {
    if (!onOpenCount) return;
    const n = openCount();
    if (n === lastOpenCount) return;
    lastOpenCount = n;
    onOpenCount(n);
  }

  function setPeers(peers: FilterPoolPeer[]): void {
    const seen = new Set<string>();
    peerOrder = [];
    for (const peer of peers) {
      const key = peerKey(peer.host, peer.port);
      if (seen.has(key)) continue;
      seen.add(key);
      peerOrder.push(key);
      const existing = endpoints.get(key);
      if (!existing) {
        endpoints.set(key, {
          peer: { ...peer },
          session: null,
          busy: false,
          coolUntil: 0,
          orphaned: false,
        });
      } else {
        existing.peer = { ...peer };
        existing.orphaned = false;
      }
    }
    for (const [key, ep] of endpoints) {
      if (seen.has(key)) continue;
      if (ep.busy) {
        ep.orphaned = true;
        continue;
      }
      void Promise.resolve(ep.session?.close()).catch(() => {});
      endpoints.delete(key);
    }
    if (cursor >= peerOrder.length) cursor = 0;
    notifyOpenCount();
  }

  function pickIdle(): Endpoint | null {
    if (peerOrder.length === 0) return null;
    const t = now();
    for (let i = 0; i < peerOrder.length; i++) {
      const key = peerOrder[(cursor + i) % peerOrder.length]!;
      const ep = endpoints.get(key);
      if (!ep || ep.busy || ep.orphaned || t < ep.coolUntil) continue;
      if (ep.session) {
        cursor = (cursor + i + 1) % peerOrder.length;
        return ep;
      }
    }
    return null;
  }

  function pickToOpen(): Endpoint | null {
    if (peerOrder.length === 0) return null;
    const t = now();
    let openCount = 0;
    for (const ep of endpoints.values()) {
      if (!ep.orphaned && (ep.session || ep.busy)) openCount++;
    }
    if (openCount >= max) return null;

    for (let i = 0; i < peerOrder.length; i++) {
      const key = peerOrder[(cursor + i) % peerOrder.length]!;
      const ep = endpoints.get(key);
      if (!ep || ep.busy || ep.session || ep.orphaned || t < ep.coolUntil) {
        continue;
      }
      cursor = (cursor + i + 1) % peerOrder.length;
      return ep;
    }
    return null;
  }

  /** ms until some cooled peer becomes eligible, or 0. */
  function coolDelayMs(): number {
    const t = now();
    let min = 0;
    for (const key of peerOrder) {
      const ep = endpoints.get(key);
      if (!ep || ep.busy || ep.orphaned || ep.session) continue;
      const wait = ep.coolUntil - t;
      if (wait <= 0) return 0;
      if (min === 0 || wait < min) min = wait;
    }
    return min;
  }

  async function ensureSession(ep: Endpoint): Promise<FilterSessionApi | null> {
    if (ep.session) return ep.session;
    const startedAt = now();
    const started = generation;
    let result: Awaited<ReturnType<typeof openSession>>;
    try {
      result = await openSession(ep.peer.host, ep.peer.port, {
        connectTimeoutMs,
        syncTimeoutMs,
        connect,
      });
    } catch (err) {
      onDiagnostic?.(
        `session open failure peer=${ep.peer.host}:${ep.peer.port} elapsedMs=${Math.max(0, now() - startedAt)} cooldownMs=${coolMs} error=${formatError(err)}`,
      );
      throw err;
    }
    if (!result.ok) {
      ep.coolUntil = now() + coolMs;
      onDiagnostic?.(
        `session open failure peer=${ep.peer.host}:${ep.peer.port} elapsedMs=${Math.max(0, now() - startedAt)} cooldownMs=${coolMs} error=${result.error}`,
      );
      return null;
    }
    if (generation !== started) {
      try {
        await Promise.resolve(result.value.close()).catch(() => {});
      } catch {
        // ignore
      }
      return null;
    }
    ep.session = result.value;
    onDiagnostic?.(
      `session open success peer=${ep.peer.host}:${ep.peer.port} elapsedMs=${Math.max(0, now() - startedAt)} services=${result.value.services}`,
    );
    return ep.session;
  }

  async function retire(ep: Endpoint): Promise<void> {
    const session = ep.session;
    ep.session = null;
    ep.busy = false;
    ep.coolUntil = now() + coolMs;
    if (session) {
      try {
        await Promise.resolve(session.close()).catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  async function finishLease(ep: Endpoint): Promise<void> {
    ep.busy = false;
    if (!ep.orphaned) return;
    const key = peerKey(ep.peer.host, ep.peer.port);
    const session = ep.session;
    ep.session = null;
    endpoints.delete(key);
    if (session) {
      try {
        await Promise.resolve(session.close()).catch(() => {});
      } catch {
        // ignore
      }
    }
  }

  async function withSession<T>(
    fn: (session: FilterSessionApi, peer: FilterPoolPeer) => Promise<T>,
  ): Promise<T | null> {
    let ep = pickIdle();
    if (!ep) {
      ep = pickToOpen();
      if (!ep) return null;
    }
    ep.busy = true;
    notifyOpenCount();
    try {
      const session = await ensureSession(ep);
      if (!session) {
        await finishLease(ep);
        return null;
      }
      const value = await fn(session, ep.peer);
      await finishLease(ep);
      return value;
    } catch (err) {
      await retire(ep);
      if (ep.orphaned) {
        const key = peerKey(ep.peer.host, ep.peer.port);
        endpoints.delete(key);
      }
      throw err;
    } finally {
      notifyOpenCount();
    }
  }

  async function closeAll(): Promise<void> {
    generation++;
    const closing: Promise<void>[] = [];
    for (const ep of endpoints.values()) {
      const session = ep.session;
      ep.session = null;
      ep.busy = false;
      ep.coolUntil = 0;
      ep.orphaned = false;
      if (session) {
        closing.push(Promise.resolve(session.close()).then(() => {}, () => {}));
      }
    }
    endpoints.clear();
    peerOrder = [];
    await Promise.all(closing);
    notifyOpenCount();
  }

  return { setPeers, withSession, coolDelayMs, closeAll };
}

export type FilterSessionPool = ReturnType<typeof createFilterSessionPool>;
