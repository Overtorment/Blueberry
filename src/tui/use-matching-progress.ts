import { useSyncExternalStore } from "react";
import type {
  MatchingProgress,
  MatchingProgressStore,
} from "./matching-progress-store.ts";

const emptyProgress: MatchingProgress = {
  scanned: 0,
  total: 0,
  at: null,
  etaMs: null,
  percent: 0,
};

let activeStore: MatchingProgressStore | null = null;

export function setActiveMatchingProgressStore(
  store: MatchingProgressStore,
): void {
  activeStore = store;
}

export function useMatchingProgress(): MatchingProgress {
  // Always read activeStore inside the callbacks — capturing it once at
  // render can freeze the hook on emptyProgress if mount races setActive.
  return useSyncExternalStore(
    (onChange) => (activeStore ? activeStore.subscribe(onChange) : () => {}),
    () => activeStore?.get() ?? emptyProgress,
    () => activeStore?.get() ?? emptyProgress,
  );
}
