import { useSyncExternalStore } from "react";
import type { UiRoute, UiRouteStore } from "./ui-route-store.ts";

let activeStore: UiRouteStore | null = null;

export function setActiveUiRouteStore(store: UiRouteStore): void {
  activeStore = store;
}

export function useUiRouteStore(): UiRouteStore | null {
  return activeStore;
}

export function useUiRoute(): UiRoute {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? "txs",
    () => store?.get() ?? "txs",
  );
}
