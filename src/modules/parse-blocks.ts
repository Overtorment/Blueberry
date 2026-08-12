import { Block } from "bitcoinjs-lib";
import { buildUtxoMap, netDeltasForTxs } from "../parse/balance.ts";
import { extractWatchTxs } from "../parse/extract.ts";
import { usedWatchIndexes } from "../parse/used-indexes.ts";
import { inspectWalletBirthday } from "../wallet/birthday.ts";
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
/** Pause between blocks so other event-loop work can run. */
const DEFAULT_BLOCK_GAP_MS = 1000;

export type ParseBlocksOptions = {
  wallet: Wallet;
  batchSize?: number;
  idleDelayMs?: number;
  /** Sleep between parsed blocks (default 1000ms). Use 0 in tests. */
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

  function kick() {
    wake?.();
  }

  function waitForKick(ms = idleDelayMs): Promise<void> {
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

  function maybeGrowWatch(): void {
    const snap = wallet.snapshot();
    // Fixed watch sets (WIF four scripts / single address) never grow HD gaps.
    if (snap.kind === "wif" || snap.kind === "address") return;
    const used = usedWatchIndexes(ctx.db.transactions.list(), snap);
    const result = growWatchGapsIfNeeded(loadWatchGaps(ctx.db), used);
    if (!result.grew) return;
    saveWatchGaps(ctx.db, result.gaps);
    wallet.refresh();
    // Rematch filters; clear parsed so prior FP downloads get re-parsed
    // against the expanded watchlist. Keep matched_blocks / blocks.
    const fromHeight = ctx.db.transactions.minHeight();
    if (fromHeight !== null) {
      ctx.db.filters.markUnscannedFrom(fromHeight);
      ctx.db.parsedBlocks.clearFrom(fromHeight);
    }
    const tip = ctx.db.headers.tip();
    const minH = ctx.db.headers.minHeight();
    const downloaded = ctx.db.filters.count();
    // Same birthday-to-tip total as filters-download so TUI progress stays coherent.
    const birthday = inspectWalletBirthday(ctx.db);
    const filterFrom =
      tip && minH !== null
        ? birthday.status === "ok"
          ? Math.max(birthday.height, minH)
          : minH
        : null;
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
  }

  async function parseBatch(): Promise<void> {
    await onParseBatch?.();

    const blocks = ctx.db.blocks.listNeedingParse(batchSize);
    const scripts = wallet.scripts();
    const utxos = buildUtxoMap(ctx.db.transactions.list(), scripts);
    for (let i = 0; i < blocks.length; i++) {
      if (stopped || !allowed) return;
      const block = blocks[i]!;
      if (ctx.db.parsedBlocks.has(block.height)) continue;
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
        if (watchTxs.length > 0) refreshNetDeltasAndEmit();
        else ctx.bus.emit("wallet:txs", { at: now() });
        maybeGrowWatch();
      } catch (err) {
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

    refreshNetDeltasAndEmit();
    // Empty backlog / startup with existing txs: still run the gap check.
    if (blocks.length === 0) maybeGrowWatch();
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      busy = true;
      needsRun = false;
      if (!allowed) {
        busy = false;
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
        return;
      }
      busy = false;
      if (stopped) return;
      if (needsRun) {
        await yieldOnce();
        continue;
      }
      await waitForKick();
    }
  }

  return {
    name: "parse-blocks",
    async start() {
      if (!stopped) return;
      stopped = false;
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
