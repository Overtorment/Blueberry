import type { Database } from "../db/types.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { WalletTxsStore } from "./wallet-txs-store.ts";
import { snapshotFromDb } from "./wallet-txs-store.ts";

type Ctx = {
  db: Database;
  wallet: Wallet;
  walletTxsStore: WalletTxsStore;
};

let active: Ctx | null = null;

export function setActiveUtxoNamesContext(
  db: Database,
  wallet: Wallet,
  walletTxsStore: WalletTxsStore,
): void {
  active = { db, wallet, walletTxsStore };
}

/** Persist a UTXO label. Trim; empty clears. Refreshes wallet txs snapshot. */
export function setUtxoName(outpoint: string, name: string): void {
  if (!active) throw new Error("utxo names context not initialized");
  const { db, wallet, walletTxsStore } = active;
  const trimmed = name.trim();
  if (trimmed === "") db.utxoNames.delete(outpoint);
  else db.utxoNames.upsert(outpoint, trimmed);
  const at = Date.now();
  walletTxsStore.apply(snapshotFromDb(db, at, at, wallet));
}
