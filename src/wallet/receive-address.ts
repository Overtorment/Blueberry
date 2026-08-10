import { Transaction } from "bitcoinjs-lib";
import {
  outpointKey,
  prevoutTxidDisplay,
  scriptHex,
} from "../parse/extract.ts";
import type { WatchAddress, WatchWallet } from "./types.ts";

/** Lowest-index external (receive) address that is not in `usedExternal`. */
export function firstUnusedExternalAddress(
  wallet: WatchWallet,
  usedExternal: readonly number[],
): WatchAddress | null {
  const used = new Set(usedExternal);
  const externals = wallet.addresses
    .filter((a) => !a.change)
    .sort((a, b) => a.index - b.index);
  for (const addr of externals) {
    if (!used.has(addr.index)) return addr;
  }
  return null;
}

/** Lowest-index internal (change) address that is not in `usedInternal`. */
export function firstUnusedInternalAddress(
  wallet: WatchWallet,
  usedInternal: readonly number[],
): WatchAddress | null {
  const used = new Set(usedInternal);
  const internals = wallet.addresses
    .filter((a) => a.change)
    .sort((a, b) => a.index - b.index);
  for (const addr of internals) {
    if (!used.has(addr.index)) return addr;
  }
  return null;
}

export type WifReceiveTxRow = {
  height: number;
  txIndex: number;
  tx: Uint8Array;
};

/**
 * For a WIF wallet: show the address type that first appeared on-chain.
 * First touch = watched output, or spend of a known watched outpoint
 * (outputs before inputs within one tx). No history → native segwit.
 */
export function preferredWifReceiveAddress(
  wallet: WatchWallet,
  txs: readonly WifReceiveTxRow[],
): WatchAddress {
  if (wallet.kind !== "wif") {
    throw new Error("preferredWifReceiveAddress requires a WIF wallet");
  }
  const byScript = new Map(
    wallet.addresses.map((a) => [scriptHex(a.scriptPubKey), a]),
  );
  const native = wallet.addresses.find((a) => a.scriptType === "p2wpkh");
  if (!native) throw new Error("WIF wallet missing native segwit address");

  const decodedRows = txs.map((row) => ({
    ...row,
    decoded: Transaction.fromBuffer(Buffer.from(row.tx)),
  }));

  const watchOutpoints = new Map<string, WatchAddress>();
  for (const { decoded } of decodedRows) {
    const txid = decoded.getId();
    decoded.outs.forEach((out, vout) => {
      const hit = byScript.get(scriptHex(out.script));
      if (hit) watchOutpoints.set(outpointKey(txid, vout), hit);
    });
  }

  const ordered = [...decodedRows].sort((a, b) => {
    if (a.height !== b.height) return a.height - b.height;
    return a.txIndex - b.txIndex;
  });

  for (const { decoded } of ordered) {
    for (const out of decoded.outs) {
      const hit = byScript.get(scriptHex(out.script));
      if (hit) return hit;
    }
    if (!decoded.isCoinbase()) {
      for (const inn of decoded.ins) {
        const hit = watchOutpoints.get(
          outpointKey(prevoutTxidDisplay(inn.hash), inn.index),
        );
        if (hit) return hit;
      }
    }
  }
  return native;
}
