import { Transaction } from "bitcoinjs-lib";
import type { WatchWallet } from "../wallet/types.ts";
import {
  outpointKey,
  p2wpkhScriptFromPubkey,
  prevoutTxidDisplay,
  scriptHex,
} from "./extract.ts";

export function usedWatchIndexes(
  txs: Array<{ tx: Uint8Array }>,
  wallet: WatchWallet,
): { external: number[]; internal: number[] } {
  const scriptToIndex = new Map<string, { change: boolean; index: number }>();
  for (const addr of wallet.addresses) {
    scriptToIndex.set(scriptHex(addr.scriptPubKey), {
      change: addr.change,
      index: addr.index,
    });
  }

  const externalUsed = new Set<number>();
  const internalUsed = new Set<number>();

  function markUsed(change: boolean, index: number): void {
    if (change) internalUsed.add(index);
    else externalUsed.add(index);
  }

  const watchOutpoints = new Map<string, { change: boolean; index: number }>();
  const decodedTxs: Transaction[] = [];
  for (const { tx } of txs) {
    const decoded = Transaction.fromBuffer(Buffer.from(tx));
    decodedTxs.push(decoded);
    const txid = decoded.getId();
    decoded.outs.forEach((o, vout) => {
      const info = scriptToIndex.get(scriptHex(o.script));
      if (info) watchOutpoints.set(outpointKey(txid, vout), info);
    });
  }

  for (const tx of decodedTxs) {
    for (const outp of tx.outs) {
      const info = scriptToIndex.get(scriptHex(outp.script));
      if (info) markUsed(info.change, info.index);
    }

    if (!tx.isCoinbase()) {
      for (const inn of tx.ins) {
        const outInfo = watchOutpoints.get(
          outpointKey(prevoutTxidDisplay(inn.hash), inn.index),
        );
        if (outInfo) markUsed(outInfo.change, outInfo.index);

        const wit = inn.witness;
        if (wit.length >= 2) {
          const pk = wit[wit.length - 1]!;
          if (pk.length === 33) {
            const info = scriptToIndex.get(
              scriptHex(p2wpkhScriptFromPubkey(pk)),
            );
            if (info) markUsed(info.change, info.index);
          }
        }
      }
    }
  }

  return {
    external: [...externalUsed].sort((a, b) => a - b),
    internal: [...internalUsed].sort((a, b) => a - b),
  };
}
