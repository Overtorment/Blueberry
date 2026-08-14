export type SyncMode = "idle" | "catchup";
export type CatchupReason = "headers" | "filters" | "blocks" | "peers";

export type SyncSnapshot = {
  /** From last headers:progress (0/0 = unknown tip). */
  headersDownloaded: number;
  headersTotal: number;
  /**
   * 0 if filters cover birthday→header tip, else 1.
   * Not `missingRanges(headersMin, headersTip).length` (that includes
   * pre-birthday heights this node never downloads).
   */
  filterMissingRangeCount: number;
  /** Filter work pending and CF peer pool below threshold. */
  filterWorkNeedsPeers: boolean;
  blocksDownloaded: number;
  blocksMatched: number;
  needingDownloadCount: number;
  alivePeerCount: number;
};

export type SyncEvaluation =
  | { mode: "idle" }
  | { mode: "catchup"; reason: CatchupReason };
