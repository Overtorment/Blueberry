import type { MessageBus } from "../bus/types.ts";

let bus: MessageBus | null = null;

export function setActiveBroadcastBus(next: MessageBus): void {
  bus = next;
}

export function requestBroadcast(txHex: string): string {
  if (!bus) throw new Error("broadcast bus not initialized");
  const id = crypto.randomUUID();
  bus.emit("broadcast:request", { id, txHex });
  return id;
}

export function cancelBroadcast(id: string): void {
  if (!bus) throw new Error("broadcast bus not initialized");
  bus.emit("broadcast:cancel", { id });
}
