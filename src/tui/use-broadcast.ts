import { useSyncExternalStore } from "react";
import {
  idleBroadcastSnapshot,
  type BroadcastStore,
  type BroadcastUiSnapshot,
} from "./broadcast-store.ts";

let active: BroadcastStore | null = null;

export function setActiveBroadcastStore(store: BroadcastStore): void {
  active = store;
}

export function useBroadcast(): BroadcastUiSnapshot {
  return useSyncExternalStore(
    (onChange) => (active ? active.subscribe(onChange) : () => {}),
    () => active?.get() ?? idleBroadcastSnapshot,
    () => active?.get() ?? idleBroadcastSnapshot,
  );
}

export function useBroadcastStore(): BroadcastStore | null {
  return active;
}
