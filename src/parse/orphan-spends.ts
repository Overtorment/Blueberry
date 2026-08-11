import type { Database } from "../db/types.ts";
import { buildUtxoMap } from "./balance.ts";

function parseOutpointKey(key: string): { txid: string; vout: number } {
  const i = key.lastIndexOf(":");
  return { txid: key.slice(0, i), vout: Number(key.slice(i + 1)) };
}

/**
 * Clear `parsed_blocks` for downloaded heights that still contain spends of
 * current wallet UTXOs. Returns how many heights were re-queued.
 */
export function requeueOrphanSpends(
  db: Database,
  watchScripts: Uint8Array[],
): number {
  const rows = db.transactions.list();
  const utxos = buildUtxoMap(
    rows.map((t) => ({
      txid: t.txid,
      height: t.height,
      txIndex: t.txIndex,
      tx: t.tx,
    })),
    watchScripts,
  );
  const cleared = new Set<number>();
  for (const [key, utxo] of utxos) {
    const { txid, vout } = parseOutpointKey(key);
    const heights = db.blocks.findHeightsContainingOutpoint(
      txid,
      vout,
      utxo.height ?? -1,
    );
    for (const height of heights) {
      if (cleared.has(height) || !db.parsedBlocks.has(height)) continue;
      db.parsedBlocks.clear(height);
      cleared.add(height);
    }
  }
  return cleared.size;
}
