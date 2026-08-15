import type { BlockHeader } from "bip324";
import {
  HeaderBranchBuilder,
  HeaderConsensusError,
  bytesToHex,
  decodeBlockHeader,
  headerHashInternal,
  hexToBytes,
  storedHeaderFromBlockHeader,
  type HeaderConsensusParams,
  type HeaderRecord,
  type ValidatedHeaderBranch,
  type ValidatedHeaderChain,
} from "bitcoin-headers";
import { BLUEBERRY_HEADER_CONSENSUS } from "../checkpoint.ts";
import { config } from "../config.ts";
import { log, logError } from "../log.ts";
import { maybeFreezeWalletBirthday } from "../wallet/birthday.ts";
import type {
  HeaderRecord as DbHeaderRecord,
  HeaderWrite,
} from "../db/types.ts";
import {
  TRUSTED_CHAIN_WINDOW,
  trustedChainFromStored,
} from "../headers/trusted-chain.ts";
import {
  SESSION_BUSY_ERROR,
  createHeaderSessionPool,
  type HeaderBatchResult,
  type HeaderSessionPool,
} from "../net/header-sync.ts";
import type { PlatformNet } from "../net/types.ts";
import { detachLoop } from "./detach-loop.ts";
import type { Module, ModuleContext } from "./types.ts";

export type ChainHeadersOptions = {
  net: PlatformNet;
  /** Injected for tests; production uses the header session pool. */
  fetchBatch?: HeaderSessionPool["fetchBatch"];
  /** Connect + handshake; keep short to skip dead peers. */
  connectTimeoutMs?: number;
  /** getheaders download after handshake. */
  headersTimeoutMs?: number;
  /** How many peers to ask in parallel for the same locator (first non-empty wins). */
  racePeers?: number;
  pollIntervalMs?: number;
  consensus?: HeaderConsensusParams;
  now?: () => number;
  /** seconds for consensus future-time checks */
  nowSeconds?: () => number;
};

type PeerRef = { host: string; port: number };

function checkpointSeedFromConsensus(
  consensus: HeaderConsensusParams,
): DbHeaderRecord {
  const header = decodeBlockHeader(consensus.checkpoint.headerBytes);
  const hashInternal = headerHashInternal(header);
  return {
    height: consensus.checkpoint.height,
    hashInternalHex: bytesToHex(hashInternal),
    header: consensus.checkpoint.headerBytes.slice(),
  };
}

function peerKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function buildLocatorHashes(
  ctx: ModuleContext,
  tipHeight: number,
  tipHashInternalHex: string,
  checkpointHeight: number,
): Uint8Array[] {
  const hashesNewestFirst: Uint8Array[] = [
    hexToBytes(tipHashInternalHex),
  ];
  let step = 1;
  let height = tipHeight - 1;
  while (height >= checkpointHeight && hashesNewestFirst.length < 32) {
    const row = ctx.db.headers.get(height);
    if (row) hashesNewestFirst.push(hexToBytes(row.hashInternalHex));
    height -= step;
    if (hashesNewestFirst.length > 10) step *= 2;
  }
  const checkpoint = ctx.db.headers.get(checkpointHeight);
  if (checkpoint && checkpointHeight < tipHeight) {
    const hex = checkpoint.hashInternalHex;
    const hasCheckpoint = hashesNewestFirst.some((h) => bytesToHex(h) === hex);
    if (!hasCheckpoint) {
      if (hashesNewestFirst.length >= 32) hashesNewestFirst.pop();
      hashesNewestFirst.push(hexToBytes(hex));
    }
  }
  return hashesNewestFirst;
}

function persistBranch(
  ctx: ModuleContext,
  branch: ValidatedHeaderBranch,
  mode: "append" | "replace",
  ancestorHeight: number,
): void {
  const writes: HeaderWrite[] = branch.headers.map((record) => ({
    height: record.height,
    hashInternalHex: record.hashInternalHex,
    header: hexToBytes(record.headerHex),
    cumulativeWork: branch.cumulativeWorkByHeight.get(record.height)!,
  }));
  if (mode === "append") {
    ctx.db.headers.append(writes);
  } else {
    ctx.db.transaction(() => {
      ctx.db.rewindAfter(ancestorHeight);
      ctx.db.headers.replaceAfter(ancestorHeight, writes);
    });
    const at = Date.now();
    ctx.bus.emit("wallet:txs", { at });
    ctx.bus.emit("blocks:progress", {
      at,
      downloaded: ctx.db.blocks.count(),
      matched: ctx.db.matchedBlocks.count(),
    });
  }
  const tipHeight = writes[writes.length - 1]!.height;
  log(
    "chain-headers",
    `${mode} after=${ancestorHeight} tip=${tipHeight} n=${writes.length}`,
  );
}

/** Extend/replace an in-memory validated chain after a successful branch apply. */
function chainAfterBranch(
  base: ValidatedHeaderChain,
  branch: ValidatedHeaderBranch,
): ValidatedHeaderChain {
  const ancestor = branch.commonAncestorHeight;
  const headers: HeaderRecord[] = [];
  const byHeight = new Map<number, HeaderRecord>();
  const heightByHashInternal = new Map<string, number>();
  const entriesByHeight = new Map(
    [...base.entriesByHeight].filter(([h]) => h <= ancestor),
  );
  const cumulativeWorkByHeight = new Map(
    [...base.cumulativeWorkByHeight].filter(([h]) => h <= ancestor),
  );

  for (const record of base.headers) {
    if (record.height > ancestor) break;
    headers.push(record);
    byHeight.set(record.height, record);
    heightByHashInternal.set(record.hashInternalHex, record.height);
  }
  for (const record of branch.headers) {
    headers.push(record);
    byHeight.set(record.height, record);
    heightByHashInternal.set(record.hashInternalHex, record.height);
  }
  for (const [height, entry] of branch.entriesByHeight) {
    entriesByHeight.set(height, entry);
  }
  for (const [height, work] of branch.cumulativeWorkByHeight) {
    cumulativeWorkByHeight.set(height, work);
  }

  return {
    headers,
    tipHeight: branch.tipHeight,
    tipHashInternal: branch.tipHashInternal.slice(),
    tipHashDisplay: branch.tipHashDisplay,
    chainWork: branch.chainWork,
    params: base.params,
    byHeight,
    heightByHashInternal,
    entriesByHeight,
    cumulativeWorkByHeight,
  };
}

type ApplyResult =
  | { status: "applied"; chain: ValidatedHeaderChain }
  | { status: "nothing_new" | "weaker" };

/** Validate *new* headers only; persisted ancestors are trusted. */
function applyHeaderBatch(
  ctx: ModuleContext,
  headers: BlockHeader[],
  base: ValidatedHeaderChain,
  consensus: HeaderConsensusParams,
  nowSeconds: () => number,
  loadChainThrough: (ancestorHeight: number) => ValidatedHeaderChain,
): ApplyResult {
  if (headers.length === 0) return { status: "nothing_new" };

  const prevHex = bytesToHex(headers[0]!.previousBlockHash);
  let ancestorHeight = base.heightByHashInternal.get(prevHex);
  if (ancestorHeight === undefined) {
    const fromDb = ctx.db.headers.heightForHashInternal(prevHex);
    if (fromDb === null) {
      throw new HeaderConsensusError(
        consensus.checkpoint.height + 1,
        "batch does not link to known chain",
      );
    }
    ancestorHeight = fromDb;
  }

  // Retarget/MTP lookback around the ancestor — not the whole chain to tip.
  const needFrom = Math.max(
    consensus.checkpoint.height,
    ancestorHeight -
      Math.max(consensus.retargetInterval, consensus.medianTimeSpan),
  );
  const chain =
    base.entriesByHeight.has(ancestorHeight) &&
    base.entriesByHeight.has(needFrom)
      ? base
      : loadChainThrough(ancestorHeight);

  const builder = new HeaderBranchBuilder(
    chain,
    ancestorHeight,
    nowSeconds(),
  );
  const records = headers.map((h, i) =>
    storedHeaderFromBlockHeader(ancestorHeight + 1 + i, h),
  );
  builder.append(records);
  const branch = builder.finish();
  if (branch.headers.length === 0) return { status: "nothing_new" };
  // Compare against the live canonical tip, not a lookback-only slice.
  if (ancestorHeight === base.tipHeight) {
    persistBranch(ctx, branch, "append", ancestorHeight);
  } else if (branch.chainWork > base.chainWork) {
    persistBranch(ctx, branch, "replace", ancestorHeight);
  } else {
    return { status: "weaker" };
  }
  return { status: "applied", chain: chainAfterBranch(chain, branch) };
}

export function createChainHeadersModule(
  ctx: ModuleContext,
  options: ChainHeadersOptions,
): Module {
  const connectTimeoutMs =
    options.connectTimeoutMs ?? config.peerProbeTimeoutMs;
  const headersTimeoutMs =
    options.headersTimeoutMs ?? config.headerSyncTimeoutMs;
  const racePeers = Math.max(1, options.racePeers ?? config.headerRacePeers);
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const consensus = options.consensus ?? BLUEBERRY_HEADER_CONSENSUS;
  const checkpointHeight = consensus.checkpoint.height;
  const now = options.now ?? Date.now;
  const nowSeconds =
    options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000));

  function emitSockets(open: number): void {
    ctx.bus.emit("peers:sockets", { at: now(), kind: "hdr", open });
  }

  // Injected fetchBatch bypasses the pool (tests). Production reuses sessions.
  const pool: HeaderSessionPool | null = options.fetchBatch
    ? null
    : createHeaderSessionPool({
        connect: options.net.connect,
        connectTimeoutMs,
        headersTimeoutMs,
        onOpenCount: emitSockets,
      });
  const fetchBatch =
    options.fetchBatch ??
    ((host, port, opts) => pool!.fetchBatch(host, port, opts));

  let stopped = true;
  let quiet = false;
  let waitingForPeers = false;
  let unsubIdle: (() => void) | undefined;
  let unsubCatchup: (() => void) | undefined;
  let wake: (() => void) | undefined;
  let unsubPeers: (() => void) | undefined;
  let loopPromise: Promise<void> | undefined;
  let maxPeerStartHeight = 0;
  let peerIndex = 0;
  let sticky: PeerRef | null = null;
  let chain: ValidatedHeaderChain | undefined;

  function pickRacePeers(alive: PeerRef[], ignore: Set<string>): PeerRef[] {
    const n = Math.min(racePeers, alive.length);
    const picked: PeerRef[] = [];
    const seen = new Set<string>();

    const push = (peer: PeerRef) => {
      const key = peerKey(peer.host, peer.port);
      if (seen.has(key) || ignore.has(key)) return;
      // Never pile onto a mid-download session — that yields instant "session busy"
      // failures and previously busy-looped the sync loop at 100% CPU.
      if (pool?.isBusy(peer.host, peer.port)) return;
      seen.add(key);
      picked.push(peer);
    };

    // Prefer sticky winner and any already-open idle sessions so we skip handshakes.
    if (
      sticky &&
      alive.some((p) => p.host === sticky!.host && p.port === sticky!.port)
    ) {
      push(sticky);
    }
    if (pool) {
      for (const peer of alive) {
        if (picked.length >= n) break;
        if (pool.has(peer.host, peer.port)) push(peer);
      }
    }
    for (let i = 0; i < alive.length && picked.length < n; i++) {
      const peer = alive[(peerIndex + i) % alive.length]!;
      if (pool?.isFull() && !pool.has(peer.host, peer.port)) continue;
      push(peer);
    }
    return picked;
  }

  /**
   * Ask several peers for the same locator; first non-empty ok response wins.
   * Empty batches wait for in-flight peers so a lagging peer cannot hide a
   * real batch. Peers that fail before the winner are returned in `failed`
   * (session-dead). "session busy" is soft — not a peer death. Late responses
   * after a winner are ignored (not marked dead). Fetch rejections are hard fails.
   */
  function raceHeaderFetch(
    peers: PeerRef[],
    locatorHashes: Uint8Array[],
  ): Promise<{
    winner:
      | { peer: PeerRef; result: Extract<HeaderBatchResult, { ok: true }> }
      | null;
    failed: PeerRef[];
    busyOnly: boolean;
  }> {
    if (peers.length === 0) {
      return Promise.resolve({ winner: null, failed: [], busyOnly: false });
    }

    return new Promise((resolve) => {
      let pending = peers.length;
      let settled = false;
      let hardFails = 0;
      const failed: PeerRef[] = [];
      let emptyWinner: {
        peer: PeerRef;
        result: Extract<HeaderBatchResult, { ok: true }>;
      } | null = null;

      const finish = (value: {
        winner:
          | { peer: PeerRef; result: Extract<HeaderBatchResult, { ok: true }> }
          | null;
        failed: PeerRef[];
        busyOnly: boolean;
      }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const onSettledPeer = () => {
        pending--;
        if (pending !== 0) return;
        if (emptyWinner) {
          finish({ winner: emptyWinner, failed, busyOnly: false });
          return;
        }
        finish({
          winner: null,
          failed,
          busyOnly: hardFails === 0,
        });
      };

      for (const peer of peers) {
        void Promise.resolve(
          fetchBatch(peer.host, peer.port, {
            connectTimeoutMs,
            headersTimeoutMs,
            locatorHashes,
          }),
        ).then(
          (result) => {
            if (settled) return;
            if (result.ok) {
              if (result.headers.length > 0) {
                finish({
                  winner: { peer, result },
                  failed,
                  busyOnly: false,
                });
                return;
              }
              emptyWinner ??= { peer, result };
              onSettledPeer();
              return;
            }
            if (result.error === SESSION_BUSY_ERROR) {
              onSettledPeer();
              return;
            }
            log(
              "chain-headers",
              `peer fail ${peerKey(peer.host, peer.port)} error=${result.error}`,
            );
            hardFails++;
            failed.push(peer);
            onSettledPeer();
          },
          (err) => {
            if (settled) return;
            logError(
              "chain-headers",
              `peer fail ${peerKey(peer.host, peer.port)}`,
              err,
            );
            hardFails++;
            failed.push(peer);
            onSettledPeer();
          },
        );
      }
    });
  }

  function kick() {
    wake?.();
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

  /** Load already-validated headers — never re-run consensus. */
  function loadTrustedWindow(throughHeight?: number): ValidatedHeaderChain {
    const tip = ctx.db.headers.tip();
    if (!tip) {
      throw new Error("headers DB has no tip");
    }
    const to =
      throughHeight === undefined
        ? tip.height
        : Math.min(tip.height, Math.max(checkpointHeight, throughHeight));
    const from = Math.max(checkpointHeight, to - TRUSTED_CHAIN_WINDOW);
    const rows = ctx.db.headers.loadRange(from, to);
    if (rows.length === 0) {
      throw new Error("trusted header window is empty");
    }
    return trustedChainFromStored(rows, consensus);
  }

  function ensureChain(): ValidatedHeaderChain {
    if (!chain) chain = loadTrustedWindow();
    return chain;
  }

  function trimChainMemory(next: ValidatedHeaderChain): ValidatedHeaderChain {
    if (next.headers.length <= TRUSTED_CHAIN_WINDOW * 2) return next;
    return loadTrustedWindow();
  }

  function emitProgress(): void {
    // Unknown peer tip → total 0 would clobber the TUI DB seed.
    if (maxPeerStartHeight <= checkpointHeight) return;
    const tipHeight = chain?.tipHeight ?? ctx.db.headers.tip()!.height;
    // Floor total at tip when a reused session's startHeight lags the tip.
    const peerTip = Math.max(maxPeerStartHeight, tipHeight);
    ctx.bus.emit("headers:progress", {
      at: now(),
      downloaded: tipHeight - checkpointHeight,
      total: Math.max(0, peerTip - checkpointHeight),
      height: tipHeight,
    });
  }

  /** Freeze create-wallet birthday only once local tip has caught the peer tip. */
  function tryFreezeBirthday(): void {
    if (maxPeerStartHeight <= checkpointHeight) return;
    const tipHeight = chain?.tipHeight ?? ctx.db.headers.tip()?.height;
    if (tipHeight === undefined || tipHeight < maxPeerStartHeight) return;
    maybeFreezeWalletBirthday(ctx.db, tipHeight);
  }

  async function runLoop(): Promise<void> {
    const dead = new Set<string>();
    const skipped = new Set<string>();
    let loggedWaiting = false;
    let loggedTipHeight = -1;

    function markPeerHardFailed(peer: PeerRef): void {
      dead.add(peerKey(peer.host, peer.port));
      void pool?.drop(peer.host, peer.port);
      ctx.db.peers.markAlive(peer.host, peer.port, false);
      ctx.bus.emit("peers:updated", { at: now() });
      if (sticky && sticky.host === peer.host && sticky.port === peer.port) {
        sticky = null;
      }
    }

    while (!stopped) {
      const allAlive = ctx.db.peers.listAlive();
      const alive = allAlive.filter((p) => !dead.has(peerKey(p.host, p.port)));

      if (alive.length === 0) {
        if (!loggedWaiting) {
          loggedWaiting = true;
          log("chain-headers", "waiting for peers");
        }
        waitingForPeers = true;
        try {
          if (allAlive.length === 0) {
            await waitForKick(pollIntervalMs);
          } else {
            dead.clear();
            skipped.clear();
            sticky = null;
            await waitForKick(250);
          }
        } finally {
          waitingForPeers = false;
        }
        continue;
      }

      loggedWaiting = false;

      const raced = pickRacePeers(alive, skipped);
      if (raced.length === 0) {
        const hasUnskipped = alive.some(
          (p) => !skipped.has(peerKey(p.host, p.port)),
        );
        if (!hasUnskipped) skipped.clear();
        await waitForKick(100);
        continue;
      }

      const tipChain = ensureChain();
      const locatorHashes = buildLocatorHashes(
        ctx,
        tipChain.tipHeight,
        bytesToHex(tipChain.tipHashInternal),
        checkpointHeight,
      );
      const { winner, failed, busyOnly } = await raceHeaderFetch(
        raced,
        locatorHashes,
      );
      if (stopped) break;

      for (const peer of failed) {
        markPeerHardFailed(peer);
      }

      if (!winner) {
        peerIndex += Math.max(1, raced.length);
        // Critical: never tight-loop on instant failures (connect refused /
        // session busy) — that pinned the event loop at 100% CPU with a frozen tip.
        await waitForKick(busyOnly ? 100 : 500);
        continue;
      }

      const { peer, result } = winner;
      sticky = peer;
      peerIndex += Math.max(1, raced.length);

      if (result.headers.length === 0) {
        // Empty ⇒ raced peers have nothing beyond our locator. Drop inflated
        // handshake startHeight so progress is not stuck below 100%.
        skipped.clear();
        maxPeerStartHeight = ensureChain().tipHeight;
        emitProgress();
        tryFreezeBirthday();
        const tipHeight = ensureChain().tipHeight;
        if (loggedTipHeight !== tipHeight) {
          loggedTipHeight = tipHeight;
          log("chain-headers", `at tip height=${tipHeight}`);
        }
        await waitForKick(pollIntervalMs);
        continue;
      }

      if (result.startHeight > checkpointHeight) {
        const prevTotal = maxPeerStartHeight;
        maxPeerStartHeight = Math.max(maxPeerStartHeight, result.startHeight);
        if (maxPeerStartHeight !== prevTotal) emitProgress();
      }

      try {
        const applied = applyHeaderBatch(
          ctx,
          result.headers,
          ensureChain(),
          consensus,
          nowSeconds,
          loadTrustedWindow,
        );
        if (applied.status === "applied") {
          skipped.clear();
          chain = trimChainMemory(applied.chain);
          emitProgress();
          tryFreezeBirthday();
          // Keep winner session open in the pool for the next batch.
          continue;
        }
        skipped.add(peerKey(peer.host, peer.port));
        sticky = null;
      } catch (err) {
        if (!(err instanceof HeaderConsensusError)) throw err;
        logError(
          "chain-headers",
          `peer fail ${peerKey(peer.host, peer.port)}`,
          err,
        );
        markPeerHardFailed(peer);
        await waitForKick(500);
      }
    }
  }

  return {
    name: "chain-headers",
    async start() {
      if (!stopped) return;
      ctx.bus.emit("module:status", {
        module: "chain-headers",
        status: "starting",
      });
      log("chain-headers", "start");
      stopped = false;
      ctx.db.headers.ensureCheckpoint(checkpointSeedFromConsensus(consensus));
      // Persisted headers are already validated — never re-validate the DB.
      // No startup progress emit: total is unknown until a peer startHeight,
      // and total:0 would flicker the TUI off its DB seed.
      unsubIdle = ctx.bus.on("sync:idle", () => {
        quiet = true;
      });
      unsubCatchup = ctx.bus.on("sync:catchup", () => {
        quiet = false;
        kick();
      });
      unsubPeers = ctx.bus.on("peers:updated", () => {
        // At-tip idle must not refetch on every probe. Wake only the
        // no-peer wait so coming back online resumes getheaders.
        if (quiet && !waitingForPeers) return;
        kick();
      });
      loopPromise = detachLoop(ctx, "chain-headers", runLoop());
      ctx.bus.emit("module:status", {
        module: "chain-headers",
        status: "running",
      });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      unsubIdle?.();
      unsubIdle = undefined;
      unsubCatchup?.();
      unsubCatchup = undefined;
      unsubPeers?.();
      unsubPeers = undefined;
      waitingForPeers = false;
      quiet = false;
      kick();
      await pool?.closeAll();
      await loopPromise;
      await pool?.closeAll();
      loopPromise = undefined;
      sticky = null;
      log("chain-headers", "stop");
      ctx.bus.emit("module:status", {
        module: "chain-headers",
        status: "stopped",
      });
    },
  };
}
