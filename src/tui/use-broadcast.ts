import { useSyncExternalStore } from "react";
import type { BroadcastStore, BroadcastUiSnapshot } from "./broadcast-store.ts";

let active: BroadcastStore | null = null;

export function setActiveBroadcastStore(store: BroadcastStore): void {
  active = store;
}

export function useBroadcast(): BroadcastUiSnapshot {
  const store = active;
  if (!store) {
    return {
      id: null,
      phase: "idle",
      attempt: null,
      maxAttempts: null,
      peer: null,
      detail: null,
      error: null,
    };
  }
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useBroadcastStore(): BroadcastStore | null {
  return active;
}
