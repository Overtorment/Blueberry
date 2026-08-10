export type ModuleStatus = "starting" | "running" | "stopped" | "error";

/** Live peer TCP socket kinds (BIP-324). */
export type PeerSocketKind = "probe" | "hdr" | "filt" | "blk";

export type EventMap = {
  "app:started": { at: number };
  "module:status": {
    module: string;
    status: ModuleStatus;
    detail?: string;
  };
  "peers:updated": { at: number };
  /** Open peer sockets for one kind; TUI merges by kind. */
  "peers:sockets": {
    at: number;
    kind: PeerSocketKind;
    open: number;
  };
  "headers:progress": {
    at: number;
    downloaded: number;
    total: number;
    /** Absolute chain tip height headers are synced to. */
    height: number;
  };
  "filters:progress": {
    at: number;
    downloaded: number;
    total: number;
  };
  "filters:match": {
    height: number;
    blockHashInternalHex: string;
  };
  "matching:progress": {
    at: number;
    matched: number;
    total: number;
  };
  "blocks:progress": {
    at: number;
    downloaded: number;
    matched: number;
  };
  "sync:idle": { at: number };
  "sync:catchup": {
    at: number;
    reason: "headers" | "filters" | "blocks" | "peers";
  };
  "wallet:txs": { at: number };
  "broadcast:request": { id: string; txHex: string };
  "broadcast:cancel": { id: string };
  "broadcast:progress": {
    id: string;
    phase: "waiting-peers" | "attempt" | "failed-attempt" | "error";
    attempt?: number;
    maxAttempts?: number;
    peer?: string;
    detail?: string;
  };
  "broadcast:done":
    | { id: string; ok: true; peer: string }
    | { id: string; ok: false; error: string };
};

export interface MessageBus {
  on<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void;
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
}
