import {
  MATCH_BATCH_GAP_MS,
  MATCH_FILTER_BATCH_SIZE,
  scanFiltersForMatches,
} from "../match/scan.ts";
import { compactFilterFrom } from "../wallet/birthday.ts";
import type { WatchGaps } from "../wallet/derive.ts";
import type { Wallet } from "../wallet/wallet.ts";
import { log, logError } from "../log.ts";
import { detachLoop } from "./detach-loop.ts";
import type { Module, ModuleContext } from "./types.ts";

const IDLE_POLL_MS = 1_000;

export type FiltersMatchingOptions = {
  wallet: Wallet;
  batchSize?: number;
  batchGapMs?: number;
  yieldFn?: () => Promise<void>;
};

function yieldOnce(): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 0);
    t.unref?.();
  });
}

export function createFiltersMatchingModule(
  ctx: ModuleContext,
  options: FiltersMatchingOptions,
): Module {
  const { wallet } = options;
  const batchSize = Math.max(1, options.batchSize ?? MATCH_FILTER_BATCH_SIZE);
  const batchGapMs = Math.max(0, options.batchGapMs ?? MATCH_BATCH_GAP_MS);
  const yieldFn = options.yieldFn ?? yieldOnce;

  let stopped = true;
  let busy = false;
  let needsRun = false;
  let wake: (() => void) | undefined;
  let unsubProgress: (() => void) | undefined;
  let loopPromise: Promise<void> | undefined;
  let loadedGaps: WatchGaps | undefined;
  let scannedCount = 0;
  let totalCount = 0;

  function kick() {
    wake?.();
  }

  function waitForKick(ms = IDLE_POLL_MS): Promise<void> {
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

  function emitProgress(): void {
    ctx.bus.emit("matching:progress", {
      at: Date.now(),
      scanned: scannedCount,
      total: totalCount,
    });
  }

  function seedProgress(): void {
    scannedCount = ctx.db.filters.countScanned();
    totalCount = ctx.db.filters.count();
    emitProgress();
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      busy = true;
      needsRun = false;
      try {
        wallet.syncFromDb();
        const gaps = wallet.gaps();
        // Use loadedGaps, not syncFromDb().grew — parse-blocks refresh() would
        // hide growth and skip re-queue after an in-flight markScanned.
        if (
          loadedGaps !== undefined &&
          (loadedGaps.external !== gaps.external ||
            loadedGaps.internal !== gaps.internal)
        ) {
          const fromHeight =
            compactFilterFrom(ctx.db) ?? ctx.db.transactions.minHeight();
          if (fromHeight !== null) {
            log(
              "filters-matching",
              `rematch from=${fromHeight} external=${gaps.external} internal=${gaps.internal}`,
            );
            ctx.db.filters.markUnscannedFrom(fromHeight);
          }
        }
        loadedGaps = gaps;
        const scannedWith = gaps;
        let matches = 0;
        const scanTotal = ctx.db.filters.count();
        const scanScanned = ctx.db.filters.countScanned();
        if (scanTotal !== scanScanned) {
          log(
            "filters-matching",
            `scan start scanned=${scanScanned} total=${scanTotal} external=${gaps.external} internal=${gaps.internal}`,
          );
        }
        const advanced = await scanFiltersForMatches(
          ctx.db,
          wallet.scripts(),
          {
            onMatch: (m) => {
              matches++;
              ctx.bus.emit("filters:match", m);
            },
            onProgress: (p) => {
              if (p.scanned === scannedCount && p.total === totalCount) return;
              scannedCount = p.scanned;
              totalCount = p.total;
              emitProgress();
            },
          },
          {
            batchSize,
            batchGapMs,
            yieldFn,
            // Abort when gaps grow mid-scan — stale scripts must not keep
            // draining a rematch queue (wasted CPU until the next loop).
            shouldContinue: () => {
              if (stopped) return false;
              const g = wallet.peekGaps();
              return (
                g.external === scannedWith.external &&
                g.internal === scannedWith.internal
              );
            },
          },
        );
        if (advanced > 0) {
          log(
            "filters-matching",
            `scan done scanned=${ctx.db.filters.countScanned()} total=${ctx.db.filters.count()} matches=${matches}`,
          );
        }
        // Peek only — sync here would advance loadedGaps before rematch.
        const gapsNow = wallet.peekGaps();
        if (
          scannedWith.external !== gapsNow.external ||
          scannedWith.internal !== gapsNow.internal
        ) {
          needsRun = true;
        }
      } catch (err) {
        logError("filters-matching", "scan", err);
        ctx.bus.emit("module:status", {
          module: "filters-matching",
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
        busy = false;
        if (stopped) return;
        await waitForKick();
        continue;
      }
      busy = false;
      if (stopped) return;
      if (needsRun) continue;
      await waitForKick();
    }
  }

  return {
    name: "filters-matching",
    async start() {
      if (!stopped) return;
      stopped = false;
      log("filters-matching", "start");
      ctx.bus.emit("module:status", {
        module: "filters-matching",
        status: "starting",
      });
      seedProgress();
      wallet.refresh();
      loadedGaps = wallet.gaps();
      unsubProgress = ctx.bus.on("filters:progress", () => {
        if (stopped) return;
        if (busy) {
          needsRun = true;
          return;
        }
        kick();
      });
      ctx.bus.emit("module:status", {
        module: "filters-matching",
        status: "running",
      });
      loopPromise = detachLoop(
        ctx,
        "filters-matching",
        (async () => {
          await yieldOnce();
          if (stopped) return;
          await loop();
        })(),
      );
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubProgress?.();
      unsubProgress = undefined;
      kick();
      await loopPromise;
      loopPromise = undefined;
      busy = false;
      needsRun = false;
      log("filters-matching", "stop");
      ctx.bus.emit("module:status", {
        module: "filters-matching",
        status: "stopped",
      });
    },
  };
}
