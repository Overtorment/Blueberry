export type ModuleStatus = "starting" | "running" | "stopped" | "error";

/** Peer work kind for `peers:sockets` counts. */
export type PeerSocketKind = "probe" | "hdr" | "filt" | "blk";

/**
 * Typed in-process event catalog.
 *
 * Durable facts live in SQLite. The TUI hydrates those into stores at start
 * and on wake. Session facts (open sockets, peer/filter range total, broadcast,
 * module status, sync idle) live in payloads; the TUI applies those fields.
 *
 * `at` fields are Unix milliseconds (`Date.now()`).
 */
export type EventMap = {
  /**
   * One module status update.
   *
   * Used for start/run/stop and also for short incident notes.
   * Not every module emits every status value.
   */
  "module:status": {
    module: string;
    status: ModuleStatus;
    detail?: string;
  };

  /** TUI wake: recount known peers from SQLite. */
  "peers:updated": { at: number };

  /**
   * Active peer work for one kind.
   *
   * `open` is the producer’s in-flight count (jobs or probes).
   * It may include work before a TCP socket is open.
   *
   * TUI applies kind/open. Not in SQLite.
   */
  "peers:sockets": {
    at: number;
    kind: PeerSocketKind;
    open: number;
  };

  /**
   * Header sync snapshot.
   *
   * `downloaded` / `total` are heights from the sync checkpoint to tip /
   * peer tip, not counts from the current run only.
   *
   * TUI wake: height/downloaded from SQLite. Apply total only if total > 0.
   */
  "headers:progress": {
    at: number;
    downloaded: number;
    total: number;
    /** Local header tip height. */
    height: number;
  };

  /**
   * Compact-filter download snapshot.
   *
   * `total` is the active birthday-to-tip range when known.
   * Wake listeners may ignore the payload and re-read the DB.
   *
   * TUI wake: downloaded from SQLite. Apply total only if total > 0.
   */
  "filters:progress": {
    at: number;
    downloaded: number;
    total: number;
  };

  /**
   * One filter hit the wallet watchlist.
   *
   * The DB row is already inserted before emit. Payload is optional context;
   * many listeners only use this as a wake signal.
   *
   * TUI wake: refresh blocks downloaded/matched from SQLite.
   */
  "filters:match": {
    height: number;
    blockHashInternalHex: string;
  };

  /**
   * Filter scan progress against the wallet.
   *
   * `scanned` is filters already checked (`countScanned`), not hit count.
   *
   * TUI wake: scanned/total from SQLite. Ignore payload counts.
   */
  "matching:progress": {
    at: number;
    scanned: number;
    total: number;
  };

  /**
   * Full-block download snapshot.
   *
   * `matched` is known matched-block rows; `downloaded` is stored full blocks.
   *
   * TUI wake: downloaded/matched from SQLite. Ignore payload counts.
   * Refresh wallet parse-backlog counts. Do not rebuild the tx list.
   */
  "blocks:progress": {
    at: number;
    downloaded: number;
    matched: number;
  };

  /** Sync evaluator entered idle (settled). */
  "sync:idle": { at: number };

  /** Sync evaluator left idle; resume catch-up work. */
  "sync:catchup": {
    at: number;
    reason: "headers" | "filters" | "blocks" | "peers";
  };

  /**
   * Wallet tx UI should refresh.
   *
   * Emitted after parse/update work. The set may be unchanged.
   *
   * TUI wake: rebuild wallet snapshot from SQLite.
   */
  "wallet:txs": { at: number };

  /** Start broadcasting one raw transaction. */
  "broadcast:request": { id: string; txHex: string };

  /** Cancel the broadcast job with this `id`, if it is active. */
  "broadcast:cancel": { id: string };

  /**
   * Broadcast job progress.
   *
   * Phases: `waiting-peers`, `attempt`, `failed-attempt`, `error`.
   * Final outcome still arrives on `broadcast:done`.
   */
  "broadcast:progress": {
    id: string;
    phase: "waiting-peers" | "attempt" | "failed-attempt" | "error";
    attempt?: number;
    maxAttempts?: number;
    peer?: string;
    detail?: string;
  };

  /**
   * Broadcast job finished.
   *
   * `ok: true` means the peer did not reject the tx. Timeout or disconnect
   * without a reject also counts as success on this path.
   */
  "broadcast:done":
    | { id: string; ok: true; peer: string }
    | { id: string; ok: false; error: string };
};

/**
 * In-process typed pub/sub.
 *
 * `emit` calls handlers in the same turn. Handlers must be synchronous;
 * thrown errors are swallowed. `on` returns an unsubscribe function.
 */
export interface MessageBus {
  on<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void;
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
}
