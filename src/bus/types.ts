export type ModuleStatus = "starting" | "running" | "stopped" | "error";

/** Live peer TCP socket kinds (BIP-324). */
export type PeerSocketKind = "probe" | "hdr" | "filt" | "blk";

/**
 * Typed event catalog for the in-process message bus.
 *
 * Keys are event names. Values are the payload shape for that event.
 * Modules talk only through this bus. They do not call each other.
 *
 * Time fields named `at` are Unix milliseconds (`Date.now()`).
 */
export type EventMap = {
  /**
   * App boot finished.
   *
   * Main emits this once after modules start and the TUI is ready.
   * Listeners can treat this as "the process is up".
   *
   * @property at - Time when the app finished starting.
   */
  "app:started": { at: number };

  /**
   * Lifecycle status for one module.
   *
   * Each module emits this when it starts, runs, stops, or hits an error.
   * The TUI shows these statuses. Other modules may ignore them.
   *
   * @property module - Module name (for example `"chain-headers"`).
   * @property status - Current lifecycle state.
   * @property detail - Optional short note (often used with `"error"`).
   */
  "module:status": {
    module: string;
    status: ModuleStatus;
    detail?: string;
  };

  /**
   * Peer set changed.
   *
   * Emitted when discovery adds, updates, or removes peers.
   * Sync modules often use this as a wake signal to retry work.
   * The TUI may refresh peer counts.
   *
   * @property at - Time of the update.
   */
  "peers:updated": { at: number };

  /**
   * Open peer TCP sockets for one socket kind.
   *
   * Modules report how many live sockets they hold for that kind.
   * The TUI merges counts by `kind` and shows them in the peer view.
   *
   * Kinds:
   * - `probe` — short connections used to find or check peers
   * - `hdr` — header sync
   * - `filt` — compact filter download
   * - `blk` — block download
   *
   * @property at - Time of the report.
   * @property kind - Which peer socket pool this count describes.
   * @property open - Number of open sockets of that kind right now.
   */
  "peers:sockets": {
    at: number;
    kind: PeerSocketKind;
    open: number;
  };

  /**
   * Header sync progress.
   *
   * Emitted while the chain-headers module downloads and stores headers.
   * Filter download and the TUI listen for this to stay aligned with tip.
   *
   * @property at - Time of the progress report.
   * @property downloaded - Headers downloaded in this sync run so far.
   * @property total - Headers this run expects to download.
   * @property height - Absolute chain tip height that headers are synced to.
   */
  "headers:progress": {
    at: number;
    downloaded: number;
    total: number;
    height: number;
  };

  /**
   * Compact filter download progress.
   *
   * Emitted while filters-download (and sometimes parse-blocks) reports
   * how many BIP157/158 filters are on disk versus needed.
   * Matching and the TUI use this to show progress and wake work.
   *
   * @property at - Time of the progress report.
   * @property downloaded - Filters stored so far.
   * @property total - Filters needed for the current goal.
   */
  "filters:progress": {
    at: number;
    downloaded: number;
    total: number;
  };

  /**
   * One compact filter matched the wallet.
   *
   * filters-matching emits this for each hit. blocks-download uses it
   * to queue that block. The TUI may refresh match-related UI.
   *
   * @property height - Block height of the match.
   * @property blockHashInternalHex - Block hash in internal hex form.
   */
  "filters:match": {
    height: number;
    blockHashInternalHex: string;
  };

  /**
   * Filter-matching progress.
   *
   * Emitted while filters-matching scans downloaded filters against the wallet.
   * The TUI shows how many filters are already checked.
   *
   * @property at - Time of the progress report.
   * @property matched - Filters already scanned against the wallet.
   * @property total - Filters known in storage (scanned + not yet scanned).
   */
  "matching:progress": {
    at: number;
    matched: number;
    total: number;
  };

  /**
   * Block download progress.
   *
   * Emitted while blocks-download fetches full blocks for filter matches.
   * parse-blocks and the TUI listen to refresh work and UI.
   *
   * @property at - Time of the progress report.
   * @property downloaded - Full blocks stored so far.
   * @property matched - Matched block hashes known so far (need download or done).
   */
  "blocks:progress": {
    at: number;
    downloaded: number;
    matched: number;
  };

  /**
   * Sync is idle: no catch-up work pending right now.
   *
   * sync-idle emits this when headers, filters, blocks, and peers look settled.
   * Network modules use it to pause aggressive sync or probe less often.
   *
   * @property at - Time when idle was detected.
   */
  "sync:idle": { at: number };

  /**
   * Sync must catch up again.
   *
   * sync-idle emits this when something falls behind after idle.
   * Network modules use it to resume download or discovery.
   *
   * @property at - Time when catch-up was requested.
   * @property reason - Which area fell behind:
   *   `headers`, `filters`, `blocks`, or `peers`.
   */
  "sync:catchup": {
    at: number;
    reason: "headers" | "filters" | "blocks" | "peers";
  };

  /**
   * Wallet transaction set changed.
   *
   * parse-blocks emits this after it parses blocks and updates wallet txs.
   * The TUI reloads the transaction list when it hears this.
   *
   * @property at - Time of the wallet update.
   */
  "wallet:txs": { at: number };

  /**
   * Ask the broadcast module to send a raw transaction.
   *
   * The TUI (or another UI action) emits this with a unique `id` and tx hex.
   * broadcast listens and starts peer broadcast attempts for that job.
   *
   * @property id - Caller-chosen job id used to track cancel/progress/done.
   * @property txHex - Raw transaction bytes as hex.
   */
  "broadcast:request": { id: string; txHex: string };

  /**
   * Cancel an in-flight broadcast job.
   *
   * Emit the same `id` used in `broadcast:request`.
   * broadcast stops further attempts for that job when it can.
   *
   * @property id - Job id from the matching `broadcast:request`.
   */
  "broadcast:cancel": { id: string };

  /**
   * Progress update for one broadcast job.
   *
   * broadcast emits this while it waits for peers, tries a peer, or records
   * a failed attempt. The TUI shows phase text to the user.
   *
   * Phases:
   * - `waiting-peers` — no suitable peer yet
   * - `attempt` — sending to a peer now
   * - `failed-attempt` — that peer try failed; may retry
   * - `error` — a hard error on this update (final result still uses `broadcast:done`)
   *
   * @property id - Job id from `broadcast:request`.
   * @property phase - What the broadcaster is doing now.
   * @property attempt - Optional 1-based attempt number.
   * @property maxAttempts - Optional attempt limit for this job.
   * @property peer - Optional peer address for this update.
   * @property detail - Optional short human-readable note.
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
   * Final result for one broadcast job.
   *
   * Success payload: `ok: true` and the peer that accepted the tx.
   * Failure payload: `ok: false` and an error string.
   * The TUI closes or updates the broadcast UI from this event.
   *
   * @property id - Job id from `broadcast:request`.
   * @property ok - `true` if a peer accepted the tx; otherwise `false`.
   * @property peer - (success) Peer that accepted the transaction.
   * @property error - (failure) Why broadcast stopped.
   */
  "broadcast:done":
    | { id: string; ok: true; peer: string }
    | { id: string; ok: false; error: string };
};

/**
 * In-process typed pub/sub bus.
 *
 * `emit` calls matching handlers in the same turn.
 * Handler errors are swallowed so one bad listener does not break others.
 * `on` returns a function that removes that handler.
 */
export interface MessageBus {
  /**
   * Subscribe to one event name.
   *
   * @param event - Event key from {@link EventMap}.
   * @param handler - Called with that event's payload on each emit.
   * @returns Unsubscribe function.
   */
  on<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void;

  /**
   * Publish one event to all current subscribers.
   *
   * @param event - Event key from {@link EventMap}.
   * @param payload - Payload that matches that event.
   */
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
}
