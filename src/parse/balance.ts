import { Transaction } from "bitcoinjs-lib";
import { outpointKey, prevoutTxidDisplay, scriptHex } from "./extract.ts";
import type { BalanceSummary, WatchUtxo } from "./types.ts";

export type TxRow = {
  txid: string;
  height: number;
  txIndex: number;
  tx: Uint8Array;
};

function sortTxRows(txs: TxRow[]): TxRow[] {
  return [...txs].sort((a, b) => {
    if (a.height !== b.height) return a.height - b.height;
    return a.txIndex - b.txIndex;
  });
}

function applyTxToState(
  tx: Transaction,
  watch: Set<string>,
  utxos: Map<string, WatchUtxo>,
  height: number,
): bigint {
  let delta = 0n;

  if (!tx.isCoinbase()) {
    for (const inn of tx.ins) {
      const key = outpointKey(prevoutTxidDisplay(inn.hash), inn.index);
      const spent = utxos.get(key);
      if (spent) {
        delta -= spent.value;
        utxos.delete(key);
      }
    }
  }

  tx.outs.forEach((o, vout) => {
    if (watch.has(scriptHex(o.script))) {
      delta += o.value;
      utxos.set(outpointKey(tx.getId(), vout), {
        value: o.value,
        scriptPubKey: o.script,
        height,
      });
    }
  });

  return delta;
}

export function buildUtxoMap(
  txs: TxRow[],
  watchScripts: Uint8Array[],
): Map<string, WatchUtxo> {
  const watch = new Set(watchScripts.map(scriptHex));
  const utxos = new Map<string, WatchUtxo>();
  for (const row of sortTxRows(txs)) {
    applyTxToState(
      Transaction.fromBuffer(Buffer.from(row.tx)),
      watch,
      utxos,
      row.height,
    );
  }
  return utxos;
}

export function netDeltasForTxs(
  txs: TxRow[],
  watchScripts: Uint8Array[],
): Map<string, bigint> {
  const watch = new Set(watchScripts.map(scriptHex));
  const utxos = new Map<string, WatchUtxo>();
  const deltas = new Map<string, bigint>();

  for (const row of sortTxRows(txs)) {
    const delta = applyTxToState(
      Transaction.fromBuffer(Buffer.from(row.tx)),
      watch,
      utxos,
      row.height,
    );
    deltas.set(row.txid, delta);
  }

  return deltas;
}

export function balanceFromTxs(
  txs: TxRow[],
  watchScripts: Uint8Array[],
): BalanceSummary {
  const utxos = buildUtxoMap(txs, watchScripts);
  let sats = 0n;
  for (const utxo of utxos.values()) {
    sats += utxo.value;
  }
  return { sats, utxoCount: utxos.size };
}
