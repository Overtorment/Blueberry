import { decodeBlockHeader } from "bitcoin-headers";
import type { Database } from "../db/types.ts";
import { buildUtxoMap } from "../parse/balance.ts";
import {
  formatBlockTimeLabel,
  padBlockTimeLabel,
} from "../parse/format-block-time.ts";
import {
  formatBtc,
  formatNetDelta,
  shortOutpoint,
  shortTxid,
  utxoValueBar,
} from "../parse/format.ts";
import type { Wallet } from "../wallet/wallet.ts";
import { estimateEtaMs, nextProgressSamples } from "./progress-eta.ts";

export type WalletTxRow = {
  txid: string;
  shortTxid: string;
  height: number;
  /** Fixed-width human-readable block time (or `#height` if header missing). */
  timeLabel: string;
  netDeltaSats: number;
  netDeltaLabel: string;
};

export type WalletUtxoRow = {
  key: string;
  txid: string;
  vout: number;
  outpointShort: string;
  valueSats: bigint;
  scriptPubKey: Uint8Array;
  amountLabel: string;
  height: number;
  ageLabel: string;
  valueBar: string;
  /** User label from utxo_names; null when unset. */
  name: string | null;
};

export type WalletTxsSnapshot = {
  at: number | null;
  balanceSats: bigint;
  balanceBtcLabel: string;
  blocksParsed: number;
  blocksTotal: number;
  /** ms until parse backlog clears; null if unknown, inactive, or no backlog */
  etaMs: number | null;
  txs: WalletTxRow[];
  utxos: WalletUtxoRow[];
};

export type WalletTxsStore = {
  get(): WalletTxsSnapshot;
  apply(snapshot: WalletTxsSnapshot): void;
  /** Update parse backlog counts without rebuilding txs / UTXOs. */
  setBlockCounts(parsed: number, total: number): void;
  setParsingActive(active: boolean): void;
  subscribe(listener: () => void): () => void;
};

export const emptyWalletTxsSnapshot: WalletTxsSnapshot = {
  at: null,
  balanceSats: 0n,
  balanceBtcLabel: formatBtc(0n),
  blocksParsed: 0,
  blocksTotal: 0,
  etaMs: null,
  txs: [],
  utxos: [],
};

function parseOutpointKey(key: string): { txid: string; vout: number } {
  const i = key.lastIndexOf(":");
  return { txid: key.slice(0, i), vout: Number(key.slice(i + 1)) };
}

function timeLabelForHeight(
  db: Database,
  height: number,
  nowMs: number,
): string {
  const stored = db.headers.get(height);
  if (!stored) return padBlockTimeLabel(`#${height}`);
  try {
    const { timestamp } = decodeBlockHeader(stored.header);
    return formatBlockTimeLabel(timestamp, nowMs);
  } catch {
    return padBlockTimeLabel(`#${height}`);
  }
}

export function snapshotFromDb(
  db: Database,
  at: number,
  nowMs: number = Date.now(),
  wallet?: Wallet,
): WalletTxsSnapshot {
  const stored = db.transactions.list();
  const balanceSats = stored.reduce((s, t) => s + BigInt(t.netDeltaSats), 0n);

  let utxos: WalletUtxoRow[] = [];
  if (wallet) {
    wallet.syncFromDb();
    const map = buildUtxoMap(
      stored.map((t) => ({
        txid: t.txid,
        height: t.height,
        txIndex: t.txIndex,
        tx: t.tx,
      })),
      wallet.scripts(),
    );
    let maxValue = 0n;
    for (const u of map.values()) {
      if (u.value > maxValue) maxValue = u.value;
    }
    const nameByOutpoint = new Map(
      db.utxoNames.list().map((r) => [r.outpoint, r.name]),
    );
    utxos = [...map.entries()]
      .map(([key, u]) => {
        const { txid, vout } = parseOutpointKey(key);
        const height = u.height ?? 0;
        return {
          key,
          txid,
          vout,
          outpointShort: shortOutpoint(txid, vout),
          valueSats: u.value,
          scriptPubKey: u.scriptPubKey,
          amountLabel: formatBtc(u.value),
          height,
          ageLabel: timeLabelForHeight(db, height, nowMs),
          valueBar: utxoValueBar(u.value, maxValue),
          name: nameByOutpoint.get(key) ?? null,
        };
      })
      .sort((a, b) => {
        if (a.height !== b.height) return b.height - a.height;
        if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
        return a.vout - b.vout;
      });
  }

  return {
    at,
    balanceSats,
    balanceBtcLabel: formatBtc(balanceSats),
    blocksParsed: db.parsedBlocks.count(),
    blocksTotal: db.blocks.count(),
    etaMs: null,
    txs: stored.map((tx) => {
      const delta = BigInt(tx.netDeltaSats);
      return {
        txid: tx.txid,
        shortTxid: shortTxid(tx.txid),
        height: tx.height,
        timeLabel: timeLabelForHeight(db, tx.height, nowMs),
        netDeltaSats: tx.netDeltaSats,
        netDeltaLabel: formatNetDelta(delta),
      };
    }),
    utxos,
  };
}

export function createWalletTxsStore(): WalletTxsStore {
  let snapshot = emptyWalletTxsSnapshot;
  let parsingActive = false;
  let samples: { at: number; downloaded: number }[] = [];
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      return snapshot;
    },
    setParsingActive(active: boolean) {
      if (parsingActive === active) return;
      parsingActive = active;
      samples = [];
      if (!active && snapshot.etaMs !== null) {
        snapshot = { ...snapshot, etaMs: null };
        notify();
      }
    },
    setBlockCounts(parsed, total) {
      if (
        snapshot.blocksParsed === parsed &&
        snapshot.blocksTotal === total
      ) {
        return;
      }
      const wasDone =
        snapshot.blocksTotal > 0 &&
        snapshot.blocksParsed >= snapshot.blocksTotal;
      const isDone = total > 0 && parsed >= total;
      if (parsed < snapshot.blocksParsed || (wasDone && !isDone)) {
        samples = [];
      }
      let etaMs = snapshot.etaMs;
      if (!parsingActive) {
        etaMs = null;
      } else if (isDone) {
        etaMs = 0;
      } else if (samples.length < 2) {
        etaMs = null;
      } else {
        etaMs = estimateEtaMs(samples, total);
      }
      snapshot = {
        ...snapshot,
        blocksParsed: parsed,
        blocksTotal: total,
        etaMs,
      };
      notify();
    },
    apply(next) {
      if (!parsingActive) {
        samples = [];
        snapshot = { ...next, etaMs: null };
        notify();
        return;
      }

      const prev = {
        downloaded: snapshot.blocksParsed,
        total: snapshot.blocksTotal,
      };
      if (next.at === null) {
        samples = [];
        snapshot = { ...next, etaMs: null };
      } else {
        const nextSamples = nextProgressSamples(samples, prev, {
          at: next.at,
          downloaded: next.blocksParsed,
          total: next.blocksTotal,
        });
        const hasBacklog = next.blocksTotal > next.blocksParsed;
        const nextEta = hasBacklog
          ? estimateEtaMs(nextSamples, next.blocksTotal)
          : null;
        samples = nextSamples;
        snapshot = { ...next, etaMs: nextEta };
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
