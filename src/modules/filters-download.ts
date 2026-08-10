import {
  CF_CHECKPT_INTERVAL,
  bytesToHex,
  deriveFilterHeaders,
  equalBytes,
  hexToBytes,
  MAX_GETCFHEADERS_RANGE,
  MAX_GETCFILTERS_RANGE,
  NODE_COMPACT_FILTERS,
  verifyCFilterAgainstHeader,
} from "bip157";
import { config } from "../config.ts";
import { createFilterSessionPool } from "../net/filter-session-pool.ts";
import { inspectWalletBirthday } from "../wallet/birthday.ts";
import {
  openFilterSession,
  type FilterSessionApi,
} from "../net/filter-sync.ts";
import type { PlatformNet } from "../net/types.ts";
import { detachLoop } from "./detach-loop.ts";
import type { Module, ModuleContext } from "./types.ts";

export type FiltersDownloadOptions = {
  net: PlatformNet;
  openSession?: typeof openFilterSession;
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
  concurrency?: number;
  filterBatchSize?: number;
  headerBatchSize?: number;
  idleDelayMs?: number;
  /** Session cool-down after failure (ms). */
  coolMs?: number;
  now?: () => number;
  /** Test seam: called when a download run starts. */
  onDownloadRun?: () => void;
};

type PeerRef = { host: string; port: number };
type HeightRange = { from: number; to: number };

function nextCheckpointHeight(from: number): number {
  return Math.ceil((from + 1) / CF_CHECKPT_INTERVAL) * CF_CHECKPT_INTERVAL;
}

/** Cap UI bus spam; OpenTUI still needs timer yields from callers to paint. */
const UI_MIN_MS = 100;

/**
 * Two-phase compact-filter sync:
 * 1) Authenticate/persist filter headers to the header tip
 * 2) Parallel getcfilters for missing ranges via a reusable session pool,
 *    verifying against in-memory header maps
 */
export function createFiltersDownloadModule(
  ctx: ModuleContext,
  options: FiltersDownloadOptions,
): Module {
  const openSession = options.openSession ?? openFilterSession;
  const connectTimeoutMs =
    options.connectTimeoutMs ?? config.peerProbeTimeoutMs;
  const syncTimeoutMs = options.syncTimeoutMs ?? config.filterSyncTimeoutMs;
  const concurrency = Math.max(
    1,
    options.concurrency ?? config.filterConcurrency,
  );
  const headerBatchSize = Math.min(
    options.headerBatchSize ?? config.filterHeaderBatchSize,
    MAX_GETCFHEADERS_RANGE,
  );
  const filterBatchSize = Math.min(
    options.filterBatchSize ?? config.filterBatchSize,
    MAX_GETCFILTERS_RANGE,
  );
  const idleDelayMs = options.idleDelayMs ?? 250;
  const now = options.now ?? Date.now;

  const pool = createFilterSessionPool({
    connect: options.net.connect,
    openSession,
    max: concurrency,
    connectTimeoutMs,
    syncTimeoutMs,
    coolMs: options.coolMs ?? 30_000,
    now,
    onOpenCount: (open) => {
      ctx.bus.emit("peers:sockets", { at: now(), kind: "filt", open });
    },
  });

  let stopped = true;
  let quiet = false;
  let busy = false;
  /** Tip advanced (or peers changed) while a run was in flight. */
  let needsRun = false;
  /** Multiple waiters — concurrent filter workers must not clobber a shared wake. */
  const waiters = new Set<() => void>();
  let unsubHeaders: (() => void) | undefined;
  let unsubPeers: (() => void) | undefined;
  let unsubIdle: (() => void) | undefined;
  let unsubCatchup: (() => void) | undefined;
  let haveCached = 0;
  let lastEmitAt = 0;
  /** Only re-check filter↔header hashes above this height. */
  let hashCheckedThrough = -1;

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

  function refreshPeers(): PeerRef[] {
    // Avoid loading the full alive peer table (100k+) into JS every refresh.
    const peers = ctx.db.peers
      .listAliveWithServices(BigInt(NODE_COMPACT_FILTERS), 512)
      .map((p) => ({ host: p.host, port: p.port }));
    if (peers.length > 0) {
      pool.setPeers(peers);
      return peers;
    }
    // Fall back to stored CF peers when none are marked alive.
    const stored = ctx.db.peers
      .listWithServices(BigInt(NODE_COMPACT_FILTERS), 256)
      .map((p) => ({ host: p.host, port: p.port }));
    pool.setPeers(stored);
    return stored;
  }

  function emitProgress(
    chainFrom: number,
    tipTo: number,
    force = false,
  ): void {
    const t = now();
    if (!force && t - lastEmitAt < UI_MIN_MS) return;
    lastEmitAt = t;
    const total = Math.max(0, tipTo - chainFrom + 1);
    ctx.bus.emit("filters:progress", {
      at: t,
      downloaded: Math.min(haveCached, total),
      total,
    });
  }

  /** Cached row count (O(1)); maxH-span wrongly treats holes as present. */
  function refreshHaveCached(): void {
    haveCached = ctx.db.filters.count();
  }

  function wipeFilterTablesFrom(height: number, rangeFrom: number): void {
    ctx.db.filters.deleteFrom(height);
    ctx.db.filterHeaders.deleteFrom(height);
    if (height === rangeFrom && rangeFrom > 0) {
      ctx.db.filterHeaders.deleteFrom(rangeFrom - 1);
    }
    hashCheckedThrough = Math.min(hashCheckedThrough, height - 1);
  }

  function reconcileReorg(from: number, to: number): void {
    const filterHeaderTip = ctx.db.filterHeaders.tip();
    if (filterHeaderTip && filterHeaderTip.height > to) {
      wipeFilterTablesFrom(to + 1, from);
    }
    const maxFilter = ctx.db.filters.maxHeight();
    if (maxFilter === null) return;
    if (maxFilter > to) wipeFilterTablesFrom(to + 1, from);

    const scanTo = Math.min(maxFilter, to);
    const scanFrom = Math.max(from, hashCheckedThrough + 1);
    if (scanFrom > scanTo) return;

    const mismatch = ctx.db.filters.firstHashMismatch(scanFrom, scanTo);
    if (mismatch !== null) {
      wipeFilterTablesFrom(mismatch, from);
      return;
    }
    hashCheckedThrough = scanTo;
  }

  function checkpointMap(headers: Uint8Array[]): Map<number, Uint8Array> {
    const map = new Map<number, Uint8Array>();
    for (let i = 0; i < headers.length; i++) {
      map.set((i + 1) * CF_CHECKPT_INTERVAL, headers[i]!);
    }
    return map;
  }

  function verifyCfHeadersBatch(
    rangeFrom: number,
    next: number,
    stop: number,
    previousFilterHeader: Uint8Array,
    filterHashes: Uint8Array[],
    checkpoints: Map<number, Uint8Array>,
  ): Uint8Array[] | null {
    const count = stop - next + 1;
    if (filterHashes.length !== count) return null;
    const derived = deriveFilterHeaders(previousFilterHeader, filterHashes);
    if (derived.length !== count) return null;

    for (let h = next; h <= stop; h++) {
      const cp = checkpoints.get(h);
      if (cp !== undefined && !equalBytes(derived[h - next]!, cp)) return null;
    }

    if (next === rangeFrom && rangeFrom % CF_CHECKPT_INTERVAL === 0) {
      const cp = checkpoints.get(rangeFrom);
      if (cp === undefined || !equalBytes(derived[0]!, cp)) return null;
    } else if (next === rangeFrom) {
      let checkpointInRange = false;
      for (let h = next; h <= stop; h++) {
        if (checkpoints.has(h)) checkpointInRange = true;
      }
      if (!checkpointInRange) return null;
    } else {
      const prevRow = ctx.db.filterHeaders.get(next - 1);
      if (
        !prevRow ||
        !equalBytes(prevRow.header, previousFilterHeader)
      ) {
        return null;
      }
    }
    return derived;
  }

  /**
   * Next filter-header height to fetch. Assumes headers are appended
   * contiguously (our write path); O(1) via tip.
   */
  function firstMissingFilterHeader(
    from: number,
    to: number,
  ): number | null {
    if (!ctx.db.filterHeaders.get(from)) return from;
    const tip = ctx.db.filterHeaders.tip();
    if (!tip || tip.height < from) return from;
    if (tip.height >= to) return null;
    return tip.height + 1;
  }

  function buildHeaderClaim(
    cursor: number,
    chainFrom: number,
    tipTo: number,
  ): HeightRange | null {
    if (cursor > tipTo) return null;
    let stop = Math.min(cursor + headerBatchSize - 1, tipTo);
    if (cursor === chainFrom && chainFrom % CF_CHECKPT_INTERVAL !== 0) {
      const nextCp = nextCheckpointHeight(chainFrom);
      if (nextCp > tipTo) return null;
      stop = Math.min(
        tipTo,
        Math.max(stop, nextCp),
        cursor + MAX_GETCFHEADERS_RANGE - 1,
      );
    }
    return { from: cursor, to: stop };
  }

  async function syncFilterHeadersPhase(
    chainFrom: number,
    tipTo: number,
    tipHashInternalHex: string,
  ): Promise<boolean> {
    let checkpointCache: {
      tipHashInternalHex: string;
      map: Map<number, Uint8Array>;
    } | null = null;

    while (!stopped) {
      const missing = firstMissingFilterHeader(chainFrom, tipTo);
      if (missing === null) return true;

      const claim = buildHeaderClaim(missing, chainFrom, tipTo);
      if (!claim) {
        await waitForKick(idleDelayMs);
        return false;
      }

      let ok = false;
      try {
        const leased = await pool.withSession(async (session, peer) => {
          if (ctx.db.filterHeaders.get(claim.from)) {
            ok = true;
            return;
          }
          if (
            !checkpointCache ||
            checkpointCache.tipHashInternalHex !== tipHashInternalHex
          ) {
            const cpHeaders = await session.getCFCheckpt(
              hexToBytes(tipHashInternalHex),
            );
            checkpointCache = {
              tipHashInternalHex,
              map: checkpointMap(cpHeaders),
            };
          }
          const stopRow = ctx.db.headers.get(claim.to);
          if (!stopRow) throw new Error("missing stop header");

          const response = await session.getCFHeaders(
            claim.from,
            hexToBytes(stopRow.hashInternalHex),
          );
          const derived = verifyCfHeadersBatch(
            chainFrom,
            claim.from,
            claim.to,
            response.previousFilterHeader,
            response.filterHashes,
            checkpointCache.map,
          );
          if (!derived) throw new Error("cfheaders verification failed");

          const rows: Array<{ height: number; header: Uint8Array }> = [];
          if (claim.from === chainFrom && chainFrom > 0) {
            rows.push({
              height: chainFrom - 1,
              header: response.previousFilterHeader.slice(),
            });
          }
          for (let i = 0; i < derived.length; i++) {
            rows.push({
              height: claim.from + i,
              header: derived[i]!.slice(),
            });
          }
          ctx.db.filterHeaders.append(rows);
          ctx.db.peers.markAlive(peer.host, peer.port, true);
          ok = true;
        });

        if (leased === null || !ok) {
          if (refreshPeers().length === 0) await waitForKick(idleDelayMs);
          else await waitForKick(50);
          continue;
        }
      } catch {
        if (refreshPeers().length === 0) await waitForKick(idleDelayMs);
        else await waitForKick(50);
        continue;
      }
      emitProgress(chainFrom, tipTo, true);
    }
    return false;
  }

  async function downloadFilterRange(
    session: FilterSessionApi,
    peer: PeerRef,
    range: HeightRange,
    chainFrom: number,
    tipTo: number,
  ): Promise<number> {
    const stopRow = ctx.db.headers.get(range.to);
    if (!stopRow) throw new Error("missing stop header");
    const expectCount = range.to - range.from + 1;

    const blockHeaders = ctx.db.headers.loadRange(range.from, range.to);
    const hashToHeight = new Map<string, number>();
    for (const h of blockHeaders) {
      hashToHeight.set(h.hashInternalHex, h.height);
    }

    const fhRows = ctx.db.filterHeaders.loadRange(
      Math.max(0, range.from - 1),
      range.to,
    );
    const filterHeaderByHeight = new Map<number, Uint8Array>();
    for (const row of fhRows) {
      filterHeaderByHeight.set(row.height, row.header);
    }

    const toStore: Array<{
      height: number;
      blockHashInternalHex: string;
      filter: Uint8Array;
    }> = [];

    const accept = (msg: {
      blockHash: Uint8Array;
      filterBytes: Uint8Array;
    }) => {
      const hashHex = bytesToHex(msg.blockHash);
      const height = hashToHeight.get(hashHex);
      if (height === undefined || height < range.from || height > range.to) {
        throw new Error("cfilter block hash out of range");
      }
      const expected = filterHeaderByHeight.get(height);
      if (!expected) throw new Error("missing filter header");
      const prev =
        height === 0
          ? new Uint8Array(32)
          : filterHeaderByHeight.get(height - 1);
      if (!prev) throw new Error("missing previous filter header");
      if (
        !verifyCFilterAgainstHeader({
          filterBytes: msg.filterBytes,
          previousFilterHeader: prev,
          expectedFilterHeader: expected,
        })
      ) {
        throw new Error("cfilter verification failed");
      }
      if (!ctx.db.filters.has(height)) {
        toStore.push({
          height,
          blockHashInternalHex: hashHex,
          filter: msg.filterBytes,
        });
      }
    };

    let streamed = false;
    const filters = await session.getCFilters(
      range.from,
      hexToBytes(stopRow.hashInternalHex),
      expectCount,
      (msg) => {
        streamed = true;
        accept(msg);
      },
    );
    // Test fakes may ignore onFilter and only return the array.
    if (!streamed) {
      for (const msg of filters) accept(msg);
    }

    if (toStore.length > 0) {
      ctx.db.filters.append(toStore);
      haveCached += toStore.length;
      emitProgress(chainFrom, tipTo, false);
    }
    ctx.db.peers.markAlive(peer.host, peer.port, true);
    return toStore.length;
  }

  /**
   * Prefer the tip gap while behind headers when the prefix has holes.
   * Full-span missingRanges scans the fat filters table (~250ms); the tip-only
   * call is cheap (no rows in range).
   */
  function filterDownloadQueue(
    chainFrom: number,
    tipTo: number,
  ): HeightRange[] {
    const maxH = ctx.db.filters.maxHeight();
    const from =
      maxH !== null &&
      maxH < tipTo &&
      !ctx.db.filters.completeInRange(chainFrom, maxH)
        ? maxH + 1
        : chainFrom;
    return ctx.db.filters
      .missingRanges(from, tipTo, filterBatchSize)
      .filter((r) => ctx.db.filterHeaders.get(r.from));
  }

  async function syncFiltersPhase(
    chainFrom: number,
    tipTo: number,
  ): Promise<void> {
    const queue = filterDownloadQueue(chainFrom, tipTo);
    if (queue.length === 0) return;

    const failures = new Map<string, number>();
    let workersDone = 0;
    const workerCount = Math.min(concurrency, Math.max(1, queue.length));

    await new Promise<void>((resolve) => {
      const runWorker = async () => {
        try {
          while (!stopped) {
            const range = queue.shift();
            if (!range) break;
            const key = `${range.from}-${range.to}`;
            try {
              const saved = await pool.withSession((session, peer) =>
                downloadFilterRange(session, peer, range, chainFrom, tipTo),
              );
              if (saved === null) {
                queue.push(range);
                const coolWait = Math.min(1_000, pool.coolDelayMs() || 50);
                await waitForKick(coolWait);
                continue;
              }
              failures.delete(key);
            } catch {
              const attempts = (failures.get(key) ?? 0) + 1;
              failures.set(key, attempts);
              if (attempts <= 8) queue.push(range);
              const coolWait = Math.min(1_000, pool.coolDelayMs() || 50);
              await waitForKick(coolWait);
            }
          }
        } finally {
          workersDone++;
          if (workersDone >= workerCount) resolve();
        }
      };
      for (let i = 0; i < workerCount; i++) void runWorker();
    });
    emitProgress(chainFrom, tipTo, true);
  }

  async function runDownload(): Promise<void> {
    options.onDownloadRun?.();
    busy = true;
    try {
      while (!stopped) {
        try {
          const birthday = inspectWalletBirthday(ctx.db);
          if (birthday.status === "pending") {
            ctx.bus.emit("filters:progress", {
              at: now(),
              downloaded: 0,
              total: 0,
            });
            await waitForKick(idleDelayMs);
            continue;
          }

          const minH = ctx.db.headers.minHeight();
          const tip = ctx.db.headers.tip();
          if (minH === null || tip === null) {
            ctx.bus.emit("filters:progress", {
              at: now(),
              downloaded: 0,
              total: 0,
            });
            break;
          }

          // Created wallets: cfilters only from birthday. Filter *headers* may
          // start at the prior BIP157 checkpoint so auth works at the tip.
          const filterFrom =
            birthday.status === "ok" ? Math.max(birthday.height, minH) : minH;
          if (tip.height < filterFrom) {
            await waitForKick(idleDelayMs);
            continue;
          }
          const chainFrom =
            birthday.status === "ok"
              ? Math.max(
                  minH,
                  Math.floor(filterFrom / CF_CHECKPT_INTERVAL) *
                    CF_CHECKPT_INTERVAL,
                )
              : minH;

          const tipTo = tip.height;
          reconcileReorg(chainFrom, tipTo);
          refreshHaveCached();
          emitProgress(filterFrom, tipTo, true);

          if (refreshPeers().length === 0) {
            await waitForKick(idleDelayMs);
            continue;
          }

          const headersDone = await syncFilterHeadersPhase(
            chainFrom,
            tipTo,
            tip.hashInternalHex,
          );
          if (!headersDone) {
            if (stopped) break;
            continue;
          }

          await syncFiltersPhase(filterFrom, tipTo);

          refreshHaveCached();
          emitProgress(filterFrom, tipTo, true);
          if (ctx.db.filters.completeInRange(filterFrom, tipTo)) {
            // Drop idle BIP-324 sessions so block-download / peers can use fds.
            await pool.closeAll();
            break;
          }

          await waitForKick(50);
        } catch {
          await waitForKick(idleDelayMs);
        }
      }
    } finally {
      busy = false;
      if (needsRun && !stopped) {
        needsRun = false;
        void detachLoop(ctx, "filters-download", runDownload());
      }
    }
  }

  function requestRun(_reason: "start" | "headers" | "peers") {
    if (stopped) return;
    if (busy) {
      needsRun = true;
      kick();
      return;
    }
    void detachLoop(ctx, "filters-download", runDownload());
  }

  return {
    name: "filters-download",
    async start() {
      if (!stopped) return;
      ctx.bus.emit("module:status", {
        module: "filters-download",
        status: "starting",
      });
      stopped = false;
      unsubHeaders = ctx.bus.on("headers:progress", () => {
        kick();
        requestRun("headers");
      });
      unsubIdle = ctx.bus.on("sync:idle", () => {
        quiet = true;
      });
      unsubCatchup = ctx.bus.on("sync:catchup", () => {
        quiet = false;
        requestRun("peers");
      });
      unsubPeers = ctx.bus.on("peers:updated", () => {
        kick();
        if (quiet) return;
        requestRun("peers");
      });
      requestRun("start");
      ctx.bus.emit("module:status", {
        module: "filters-download",
        status: "running",
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      needsRun = false;
      unsubHeaders?.();
      unsubHeaders = undefined;
      unsubIdle?.();
      unsubIdle = undefined;
      unsubCatchup?.();
      unsubCatchup = undefined;
      unsubPeers?.();
      unsubPeers = undefined;
      kick();
      await pool.closeAll();
      ctx.bus.emit("module:status", {
        module: "filters-download",
        status: "stopped",
      });
    },
  };
}
