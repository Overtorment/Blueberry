import { Block } from "bitcoinjs-lib";
import { buildUtxoMap, netDeltasForTxs } from "../parse/balance.ts";
import { extractWatchTxs } from "../parse/extract.ts";
import { usedWatchIndexes } from "../parse/used-indexes.ts";
import { compactFilterFrom } from "../wallet/birthday.ts";
import type { Wallet } from "../wallet/wallet.ts";
import {
  growWatchGapsIfNeeded,
  loadWatchGaps,
  saveWatchGaps,
} from "../wallet/watch-gaps.ts";
import { detachLoop } from "./detach-loop.ts";
import type { Module, ModuleContext } from "./types.ts";

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_IDLE_DELAY_MS = 1_000;
/** Pause between blocks so other event-loop work can run. 0 = yield only. */
const DEFAULT_BLOCK_GAP_MS = 0;

export type ParseBlocksOptions = {
  wallet: Wallet;
  batchSize?: number;
  /** Backoff after an unexpected batch error (default 1000ms). Idle waits are kick-driven. */
  idleDelayMs?: number;
  /** Sleep between parsed blocks (default 0). Use 0 in tests. */
  blockGapMs?: number;
  now?: () => number;
  /** Test seam: called at the start of each batch while busy. */
  onParseBatch?: () => Promise<void> | void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

function yieldOnce(): Promise<void> {
  return sleep(0);
}

export function createParseBlocksModule(
  ctx: ModuleContext,
  options: ParseBlocksOptions,
): Module {
  const { wallet } = options;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
  const idleDelayMs = Math.max(0, options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS);
  const blockGapMs = Math.max(0, options.blockGapMs ?? DEFAULT_BLOCK_GAP_MS);
  const now = options.now ?? Date.now;
  const onParseBatch = options.onParseBatch;

  let stopped = true;
  let allowed = false;
  let busy = false;
  let needsRun = false;
  let wake: (() => void) | undefined;
  let unsubProgress: (() => void) | undefined;
  let unsubIdle: (() => void) | undefined;
  let unsubCatchup: (() => void) | undefined;
  let loopPromise: Promise<void> | undefined;
  const failedHeights = new Set<number>();

  function kick() {
    wake?.();
  }

  function waitForKick(ms?: number): Promise<void> {
    return new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (wake === done) wake = undefined;
        resolve();
      };
      if (ms !== undefined) {
        timer = setTimeout(done, ms);
        timer.unref?.();
      }
      wake = done;
    });
  }

  function refreshNetDeltasAndEmit(): void {
    const snap = wallet.snapshot();
    const rows = ctx.db.transactions.list();
    const deltas = netDeltasForTxs(rows, snap.scripts);
    for (const row of rows) {
      const d = deltas.get(row.txid) ?? 0n;
      if (BigInt(row.netDeltaSats) !== d) {
        // Normal wallet amounts fit Number.MAX_SAFE_INTEGER.
        ctx.db.transactions.setNetDelta(row.txid, Number(d));
      }
    }
    ctx.bus.emit("wallet:txs", { at: now() });
  }

  function maybeGrowWatch(): boolean {
    const snap = wallet.snapshot();
    // Fixed watch sets (WIF four scripts / single address) never grow HD gaps.
    if (snap.kind === "wif" || snap.kind === "address") return false;
    const used = usedWatchIndexes(ctx.db.transactions.list(), snap);
    const result = growWatchGapsIfNeeded(loadWatchGaps(ctx.db), used);
    if (!result.grew) return false;
    saveWatchGaps(ctx.db, result.gaps);
    wallet.refresh();
    // Rematch filters; clear parsed so prior FP downloads get re-parsed
    // against the expanded watchlist. Keep matched_blocks / blocks.
    const fromHeight =
      compactFilterFrom(ctx.db) ?? ctx.db.transactions.minHeight();
    if (fromHeight !== null) {
      ctx.db.filters.markUnscannedFrom(fromHeight);
      ctx.db.parsedBlocks.clearFrom(fromHeight);
    }
    const tip = ctx.db.headers.tip();
    const downloaded = ctx.db.filters.count();
    const filterFrom = compactFilterFrom(ctx.db);
    const total =
      tip && filterFrom !== null
        ? Math.max(0, tip.height - filterFrom + 1)
        : downloaded;
    ctx.bus.emit("filters:progress", {
      at: now(),
      downloaded: Math.min(downloaded, total),
      total,
    });
    needsRun = true;
    return true;
  }

  async function parseBatch(): Promise<void> {
    await onParseBatch?.();

    const listed = ctx.db.blocks.listNeedingParse(
      batchSize + failedHeights.size + 1,
    );
    const blocks = [];
    for (const block of listed) {
      if (failedHeights.has(block.height)) continue;
      if (blocks.length >= batchSize) {
        needsRun = true;
        break;
      }
      blocks.push(block);
    }
    if (blocks.length === 0) {
      maybeGrowWatch();
      refreshNetDeltasAndEmit();
      return;
    }

    const scripts = wallet.scripts();
    const utxos = buildUtxoMap(ctx.db.transactions.list(), scripts);
    let sawWatchTx = false;
    for (let i = 0; i < blocks.length; i++) {
      if (stopped || !allowed) return;
      const block = blocks[i]!;
      await yieldOnce();
      if (stopped || !allowed) return;
      try {
        const parsed = Block.fromBuffer(Buffer.from(block.block));
        const watchTxs = extractWatchTxs(parsed, scripts, utxos);
        for (const tx of watchTxs) {
          ctx.db.transactions.upsert({
            txid: tx.txid,
            height: block.height,
            txIndex: tx.txIndex,
            blockHashInternalHex: block.blockHashInternalHex,
            tx: tx.tx,
            netDeltaSats: 0,
          });
        }
        ctx.db.parsedBlocks.mark(block.height);
        if (watchTxs.length > 0) {
          sawWatchTx = true;
          refreshNetDeltasAndEmit();
          // Stale scripts/UTXOs must not mark later heights in this snapshot.
          if (maybeGrowWatch()) return;
        } else {
          ctx.bus.emit("wallet:txs", { at: now() });
        }
      } catch (err) {
        failedHeights.add(block.height);
        ctx.bus.emit("module:status", {
          module: "parse-blocks",
          status: "error",
          detail:
            err instanceof Error
              ? `height ${block.height}: ${err.message}`
              : `height ${block.height}: ${String(err)}`,
        });
      }
      if (!allowed) return;
      if (i + 1 < blocks.length) {
        if (blockGapMs > 0) await sleep(blockGapMs);
        else await yieldOnce();
        if (stopped || !allowed) return;
      }
    }

    // False-positive batches still check existing txs for danger-zone growth.
    if (!sawWatchTx) maybeGrowWatch();
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      busy = true;
      needsRun = false;
      if (!allowed) {
        busy = false;
        failedHeights.clear();
        await waitForKick();
        continue;
      }
      try {
        await parseBatch();
      } catch (err) {
        ctx.bus.emit("module:status", {
          module: "parse-blocks",
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
        busy = false;
        if (stopped) return;
        await waitForKick(idleDelayMs);
        continue;
      }
      busy = false;
      if (stopped) return;
      if (needsRun) {
        await yieldOnce();
        continue;
      }
      failedHeights.clear();
      await waitForKick();
    }
  }

  return {
    name: "parse-blocks",
    async start() {
      if (!stopped) return;
      stopped = false;
      failedHeights.clear();
      ctx.bus.emit("module:status", {
        module: "parse-blocks",
        status: "starting",
      });
      wallet.refresh();

      unsubProgress = ctx.bus.on("blocks:progress", () => {
        if (stopped) return;
        if (busy) {
          needsRun = true;
          return;
        }
        kick();
      });
      unsubIdle = ctx.bus.on("sync:idle", () => {
        if (stopped) return;
        allowed = true;
        if (busy) {
          needsRun = true;
          return;
        }
        kick();
      });
      unsubCatchup = ctx.bus.on("sync:catchup", () => {
        allowed = false;
      });

      ctx.bus.emit("module:status", {
        module: "parse-blocks",
        status: "running",
      });

      loopPromise = detachLoop(
        ctx,
        "parse-blocks",
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
      allowed = false;
      unsubProgress?.();
      unsubProgress = undefined;
      unsubIdle?.();
      unsubIdle = undefined;
      unsubCatchup?.();
      unsubCatchup = undefined;
      kick();
      await loopPromise;
      loopPromise = undefined;
      busy = false;
      needsRun = false;
      ctx.bus.emit("module:status", {
        module: "parse-blocks",
        status: "stopped",
      });
    },
  };
}
