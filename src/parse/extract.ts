import { Block, crypto, script as bscript } from "bitcoinjs-lib";
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

function p2pkhScriptFromPubkey(pubkey: Uint8Array): Uint8Array {
  const h = crypto.hash160(pubkey);
  return new Uint8Array([0x76, 0xa9, 0x14, ...h, 0x88, 0xac]);
}

function p2shP2wpkhScriptFromPubkey(pubkey: Uint8Array): Uint8Array {
  const redeemHash = crypto.hash160(p2wpkhScriptFromPubkey(pubkey));
  return new Uint8Array([0xa9, 0x14, ...redeemHash, 0x87]);
}

function isPubkeyBytes(value: Uint8Array): boolean {
  return value.length === 33 || value.length === 65;
}

/** Best-effort pubkey from a legacy scriptSig (`<sig> <pubkey>`). */
function pubkeyFromScriptSig(scriptSig: Uint8Array): Uint8Array | null {
  try {
    const chunks = bscript.decompile(Buffer.from(scriptSig));
    if (!chunks) return null;
    for (let i = chunks.length - 1; i >= 0; i--) {
      const chunk = chunks[i];
      if (
        chunk instanceof Uint8Array &&
        isPubkeyBytes(chunk)
      ) {
        return new Uint8Array(chunk);
      }
    }
  } catch {
    // ignore malformed scriptSig
  }
  return null;
}

/**
 * Watched scriptPubKeys implied by an input's unlocking data, independent of
 * whether the spent outpoint is already in the UTXO map.
 */
export function watchedScriptsFromInput(input: {
  script: Uint8Array;
  witness: Uint8Array[];
}): Uint8Array[] {
  const out: Uint8Array[] = [];
  const wit = input.witness;
  if (wit.length >= 2) {
    const pk = wit[wit.length - 1]!;
    if (pk.length === 33) {
      out.push(p2wpkhScriptFromPubkey(pk));
      out.push(p2shP2wpkhScriptFromPubkey(pk));
    }
  }
  const fromSig = pubkeyFromScriptSig(input.script);
  if (fromSig) out.push(p2pkhScriptFromPubkey(fromSig));
  return out;
}

function inputMatchesWatch(
  input: { script: Uint8Array; witness: Uint8Array[] },
  watch: Set<string>,
): boolean {
  for (const script of watchedScriptsFromInput(input)) {
    if (watch.has(scriptHex(script))) return true;
  }
  return false;
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
        if (utxos.has(key) || inputMatchesWatch(inn, watch)) {
          relevant = true;
          break;
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
