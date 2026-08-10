import { useSyncExternalStore } from "react";
import type { PeerSocketCounts, PeerSocketsStore } from "./peer-sockets-store.ts";

let activeStore: PeerSocketsStore | null = null;

const ZERO: PeerSocketCounts = {
  known: 0,
  probe: 0,
  hdr: 0,
  filt: 0,
  blk: 0,
};

export function setActivePeerSocketsStore(store: PeerSocketsStore): void {
  activeStore = store;
}

export function usePeerSockets(): PeerSocketCounts {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? ZERO,
    () => store?.get() ?? ZERO,
  );
}
