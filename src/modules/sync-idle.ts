import { NODE_COMPACT_FILTERS } from "bip157";
import { evaluateSyncState } from "../sync/evaluate.ts";
import type { SyncMode, SyncSnapshot } from "../sync/types.ts";
import { inspectWalletBirthday } from "../wallet/birthday.ts";
import type { Module, ModuleContext } from "./types.ts";

/** Bitcoin NODE_NETWORK — peer can serve historical blocks. */
const NODE_NETWORK = 1n;

export type SyncIdleOptions = {
  evalIntervalMs?: number;
  minAliveCompactFilters?: number;
  now?: () => number;
};

export function createSyncIdleModule(
  ctx: ModuleContext,
  options: SyncIdleOptions = {},
): Module {
  const evalIntervalMs = options.evalIntervalMs ?? 5_000;
  const minAliveCompactFilters = options.minAliveCompactFilters ?? 16;
  const now = options.now ?? Date.now;

  let stopped = true;
  let mode: SyncMode = "catchup";
  let idleStreak = 0;
  let headersDownloaded = 0;
  let headersTotal = 0;
  let blocksDownloaded = 0;
  let blocksMatched = 0;
  let intervalId: ReturnType<typeof setInterval> | undefined;
  const unsubs: (() => void)[] = [];

  function buildSnapshot(): SyncSnapshot {
    const minH = ctx.db.headers.minHeight();
    const tip = ctx.db.headers.tip();
    // Avoid filters.missingRanges here: with internal gaps it scans the fat
    // BLOB table (~250ms) and starves keypress/quit on every filters:progress.
    // Create-wallets only sync cfilters from birthday→tip (not header checkpoint).
    const birthday = inspectWalletBirthday(ctx.db);
    let filterMissingRangeCount = 1;
    if (minH !== null && tip !== null && birthday.status !== "pending") {
      const filterFrom =
        birthday.status === "ok" ? Math.max(birthday.height, minH) : minH;
      filterMissingRangeCount =
        tip.height < filterFrom ||
        !ctx.db.filters.completeInRange(filterFrom, tip.height)
          ? 1
          : 0;
    }

    const alivePeerCount =
      ctx.db.peers.listAliveWithServices(NODE_NETWORK, 1).length > 0 ||
      ctx.db.peers.listAliveWithServices(BigInt(NODE_COMPACT_FILTERS), 1)
        .length > 0
        ? 1
        : 0;

    const needingDownloadCount =
      ctx.db.matchedBlocks.listNeedingDownload(1).length;
    // CF pool size only changes the catchup *reason* when leaving idle with
    // filter work. Skip the extra scan on the catchup/idle-complete path.
    const filterWorkNeedsPeers =
      mode === "idle" &&
      filterMissingRangeCount > 0 &&
      ctx.db.peers.listAliveWithServices(
        BigInt(NODE_COMPACT_FILTERS),
        minAliveCompactFilters,
      ).length < minAliveCompactFilters;

    return {
      headersDownloaded,
      headersTotal,
      filterMissingRangeCount,
      filterWorkNeedsPeers,
      blocksDownloaded,
      blocksMatched,
      needingDownloadCount,
      alivePeerCount,
    };
  }

  function applyEvaluation(evalResult: ReturnType<typeof evaluateSyncState>): void {
    if (evalResult.mode === "idle") {
      idleStreak++;
      if (mode === "catchup" && idleStreak >= 2) {
        mode = "idle";
        ctx.bus.emit("sync:idle", { at: now() });
        ctx.bus.emit("module:status", {
          module: "sync-idle",
          status: "running",
          detail: "idle",
        });
      }
      return;
    }

    idleStreak = 0;

    if (mode === "idle") {
      mode = "catchup";
      ctx.bus.emit("sync:catchup", {
        at: now(),
        reason: evalResult.reason,
      });
      ctx.bus.emit("module:status", {
        module: "sync-idle",
        status: "running",
        detail: `catchup:${evalResult.reason}`,
      });
    }
  }

  function evaluate(): void {
    if (stopped) return;
    applyEvaluation(evaluateSyncState(buildSnapshot()));
  }

  // Match/peer churn is noisy during catchup and cannot transition
  // until a progress eval starts the idle streak.
  function evaluateAfterChurn(): void {
    if (mode === "catchup" && idleStreak === 0) return;
    evaluate();
  }

  return {
    name: "sync-idle",
    async start() {
      if (!stopped) return;
      ctx.bus.emit("module:status", {
        module: "sync-idle",
        status: "starting",
      });
      stopped = false;
      mode = "catchup";
      idleStreak = 0;
      headersDownloaded = 0;
      headersTotal = 0;
      blocksDownloaded = ctx.db.blocks.count();
      blocksMatched = ctx.db.matchedBlocks.count();

      unsubs.push(
        ctx.bus.on("headers:progress", (p) => {
          headersDownloaded = p.downloaded;
          headersTotal = p.total;
          evaluate();
        }),
        ctx.bus.on("blocks:progress", (p) => {
          blocksDownloaded = p.downloaded;
          blocksMatched = p.matched;
          evaluate();
        }),
        ctx.bus.on("filters:progress", () => {
          evaluate();
        }),
        ctx.bus.on("filters:match", evaluateAfterChurn),
        ctx.bus.on("peers:updated", evaluateAfterChurn),
      );

      intervalId = setInterval(evaluate, evalIntervalMs);
      intervalId.unref?.();

      ctx.bus.emit("module:status", {
        module: "sync-idle",
        status: "running",
      });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (intervalId !== undefined) {
        clearInterval(intervalId);
        intervalId = undefined;
      }
      for (const unsub of unsubs) unsub();
      unsubs.length = 0;
      ctx.bus.emit("module:status", {
        module: "sync-idle",
        status: "stopped",
      });
    },
  };
}
