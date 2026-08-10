import { Block, crypto } from "bitcoinjs-lib";
import type { ExtractedWatchTx, WatchUtxo } from "./types.ts";

export function scriptHex(script: Uint8Array): string {
  return Buffer.from(script).toString("hex");
}

export function outpointKey(txidDisplay: string, vout: number): string {
  return `${txidDisplay}:${vout}`;
}

/** Prevout txid display hex from bitcoinjs input.hash (internal byte order). */
export function prevoutTxidDisplay(inputHash: Uint8Array): string {
  return Buffer.from(inputHash).reverse().toString("hex");
}

export function p2wpkhScriptFromPubkey(pubkey: Uint8Array): Uint8Array {
  const h = crypto.hash160(pubkey);
  return new Uint8Array([0x00, 0x14, ...h]);
}

/** Mutates `utxos` for same-block chaining / subsequent blocks. */
export function extractWatchTxs(
  block: Block,
  watchScripts: Uint8Array[],
  utxos: Map<string, WatchUtxo>,
): ExtractedWatchTx[] {
  const watch = new Set(watchScripts.map(scriptHex));
  const out: ExtractedWatchTx[] = [];
  const txs = block.transactions ?? [];
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    let relevant = false;
    if (!tx.isCoinbase()) {
      for (const inn of tx.ins) {
        const key = outpointKey(prevoutTxidDisplay(inn.hash), inn.index);
        if (utxos.has(key)) {
          relevant = true;
          break;
        }
        const wit = inn.witness;
        if (wit.length >= 2) {
          const pk = wit[wit.length - 1]!;
          if (
            pk.length === 33 &&
            watch.has(scriptHex(p2wpkhScriptFromPubkey(pk)))
          ) {
            relevant = true;
            break;
          }
        }
      }
    }
    for (const outp of tx.outs) {
      if (watch.has(scriptHex(outp.script))) relevant = true;
    }
    if (!relevant) continue;
    out.push({ txid: tx.getId(), txIndex: i, tx: tx.toBuffer() });
    if (!tx.isCoinbase()) {
      for (const inn of tx.ins) {
        utxos.delete(outpointKey(prevoutTxidDisplay(inn.hash), inn.index));
      }
    }
    tx.outs.forEach((o, vout) => {
      if (watch.has(scriptHex(o.script))) {
        utxos.set(outpointKey(tx.getId(), vout), {
          value: o.value,
          scriptPubKey: o.script,
        });
      }
    });
  }
  return out;
}
