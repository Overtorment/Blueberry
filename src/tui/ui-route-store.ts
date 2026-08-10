export type UiRoute = "txs" | "receive" | "send";

export type UiRouteStore = {
  get(): UiRoute;
  subscribe(listener: () => void): () => void;
  open(route: "receive" | "send"): void;
  close(): void;
};

export function createUiRouteStore(): UiRouteStore {
  let route: UiRoute = "txs";
  const listeners = new Set<() => void>();

  function set(next: UiRoute): void {
    if (route === next) return;
    route = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      return route;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(next) {
      set(next);
    },
    close() {
      set("txs");
    },
  };
}
