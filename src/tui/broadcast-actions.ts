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
  const snap = store.get();
  if (broadcastJobInFlight(snap.phase)) return;
  if (snap.phase === "success") {
    if (snap.txHex === txHex) return;
    store.reset();
  } else if (snap.phase === "error") {
    store.reset();
  }
  const id = crypto.randomUUID();
  store.begin(id, txHex);
  requestBroadcast(txHex, id);
}

export function cancelBroadcast(id: string): void {
  if (!bus) throw new Error("broadcast bus not initialized");
  bus.emit("broadcast:cancel", { id });
}

/**
 * Esc while a signed broadcast is in-flight.
 * Arm cancel per job id so a retry after error does not inherit force-close.
 */
export function inFlightBroadcastEscape(
  phase: string | undefined,
  id: string | null | undefined,
  cancelArmedForId: string | null,
): "ignore" | "cancel" | "force-close" {
  if (
    !id ||
    (phase !== "waiting-peers" && phase !== "attempt")
  ) {
    return "ignore";
  }
  return cancelArmedForId === id ? "force-close" : "cancel";
}

/** True while the module may still be running this job (do not reset the store). */
export function broadcastJobInFlight(
  phase: string | undefined,
): boolean {
  return phase === "waiting-peers" || phase === "attempt";
}

/** Progress/success/error UI belongs only to the preview of that signed hex. */
export function previewOwnsBroadcastJob(
  storeTxHex: string | null | undefined,
  previewTxHex: string | undefined,
): boolean {
  return !!storeTxHex && !!previewTxHex && storeTxHex === previewTxHex;
}

export function previewShowsBroadcastUi(
  phase: string | undefined,
  storeTxHex: string | null | undefined,
  previewTxHex: string,
): boolean {
  if (!previewOwnsBroadcastJob(storeTxHex, previewTxHex)) return false;
  return (
    phase === "waiting-peers" ||
    phase === "attempt" ||
    phase === "success" ||
    phase === "error"
  );
}
