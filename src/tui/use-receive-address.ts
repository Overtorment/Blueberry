import { useSyncExternalStore } from "react";
import type {
  ReceiveAddressSnapshot,
  ReceiveAddressStore,
} from "./receive-address-store.ts";
import { emptyReceiveAddressSnapshot } from "./receive-address-store.ts";

let activeStore: ReceiveAddressStore | null = null;

export function setActiveReceiveAddressStore(store: ReceiveAddressStore): void {
  activeStore = store;
}

export function useReceiveAddress(): ReceiveAddressSnapshot {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? emptyReceiveAddressSnapshot,
    () => store?.get() ?? emptyReceiveAddressSnapshot,
  );
}
