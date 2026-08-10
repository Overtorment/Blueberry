import type { ModuleStatus } from "../bus/types.ts";

export type ModuleStatusEntry = {
  status: ModuleStatus;
  detail?: string;
};

export type ModuleStatusStore = {
  get(module: string): ModuleStatusEntry | undefined;
  set(module: string, entry: ModuleStatusEntry): void;
  subscribe(listener: () => void): () => void;
};

export function createModuleStatusStore(): ModuleStatusStore {
  const map = new Map<string, ModuleStatusEntry>();
  const listeners = new Set<() => void>();

  return {
    get(module) {
      return map.get(module);
    },
    set(module, entry) {
      const prev = map.get(module);
      if (
        prev &&
        prev.status === entry.status &&
        prev.detail === entry.detail
      ) {
        return;
      }
      map.set(module, entry);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
