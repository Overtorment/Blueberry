import { useSyncExternalStore } from "react";
import type { ModuleStatusStore } from "./status-store.ts";

let activeStore: ModuleStatusStore | null = null;

export function setActiveStatusStore(store: ModuleStatusStore): void {
  activeStore = store;
}

export function useModuleStatus(moduleName: string): string {
  const store = activeStore;
  const entry = useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get(moduleName),
    () => store?.get(moduleName),
  );
  if (!entry) return "idle";
  return entry.detail ? `${entry.status}: ${entry.detail}` : entry.status;
}
