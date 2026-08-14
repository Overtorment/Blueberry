import type { MessageBus } from "../bus/types.ts";
import type { BroadcastStore } from "./broadcast-store.ts";

let bus: MessageBus | null = null;

export function setActiveBroadcastBus(next: MessageBus): void {
  bus = next;
}

export function requestBroadcast(
  txHex: string,
  id: string = crypto.randomUUID(),
): string {
  if (!bus) throw new Error("broadcast bus not initialized");
  bus.emit("broadcast:request", { id, txHex });
  return id;
}

/**
 * Begin the store job first, then emit the request, so a synchronous
 * `broadcast:done` (bad hex, already in progress) is not overwritten.
 */
export function startUiBroadcast(store: BroadcastStore, txHex: string): void {
  const phase = store.get().phase;
  if (phase === "waiting-peers" || phase === "attempt") return;
  if (phase === "success") {
    store.reset();
    return;
  }
  if (phase === "error") store.reset();
  const id = crypto.randomUUID();
  store.begin(id);
  requestBroadcast(txHex, id);
}

export function cancelBroadcast(id: string): void {
  if (!bus) throw new Error("broadcast bus not initialized");
  bus.emit("broadcast:cancel", { id });
}
