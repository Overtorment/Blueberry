import { useSyncExternalStore } from "react";
import type {
  BlocksMatchedStore,
  BlocksProgress,
} from "./blocks-matched-store.ts";

const empty: BlocksProgress = {
  downloaded: 0,
  matched: 0,
  at: null,
  etaMs: null,
  percent: 0,
};

let activeStore: BlocksMatchedStore | null = null;

export function setActiveBlocksMatchedStore(store: BlocksMatchedStore): void {
  activeStore = store;
}

export function useBlocksProgress(): BlocksProgress {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? empty,
    () => store?.get() ?? empty,
  );
}
