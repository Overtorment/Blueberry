import { useSyncExternalStore } from "react";
import type {
  FiltersProgress,
  FiltersProgressStore,
} from "./filters-progress-store.ts";

const emptyProgress: FiltersProgress = {
  downloaded: 0,
  total: 0,
  at: null,
  etaMs: null,
  percent: 0,
};

let activeStore: FiltersProgressStore | null = null;

export function setActiveFiltersProgressStore(
  store: FiltersProgressStore,
): void {
  activeStore = store;
}

export function useFiltersProgress(): FiltersProgress {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? emptyProgress,
    () => store?.get() ?? emptyProgress,
  );
}
