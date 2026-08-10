import { useSyncExternalStore } from "react";
import type { WalletTxsSnapshot, WalletTxsStore } from "./wallet-txs-store.ts";
import { emptyWalletTxsSnapshot } from "./wallet-txs-store.ts";

let activeStore: WalletTxsStore | null = null;

export function setActiveWalletTxsStore(store: WalletTxsStore): void {
  activeStore = store;
}

export function useWalletTxs(): WalletTxsSnapshot {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? emptyWalletTxsSnapshot,
    () => store?.get() ?? emptyWalletTxsSnapshot,
  );
}
