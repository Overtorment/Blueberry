import { useSyncExternalStore } from "react";
import type {
  HeadersProgress,
  HeadersProgressStore,
} from "./headers-progress-store.ts";

const emptyProgress: HeadersProgress = {
  downloaded: 0,
  total: 0,
  height: 0,
  at: null,
  etaMs: null,
  percent: 0,
};

let activeStore: HeadersProgressStore | null = null;

export function setActiveHeadersProgressStore(
  store: HeadersProgressStore,
): void {
  activeStore = store;
}

export function useHeadersProgress(): HeadersProgress {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? emptyProgress,
    () => store?.get() ?? emptyProgress,
  );
}
