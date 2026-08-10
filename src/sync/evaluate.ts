import type { SyncEvaluation, SyncSnapshot } from "./types.ts";

export function evaluateSyncState(s: SyncSnapshot): SyncEvaluation {
  if (s.alivePeerCount === 0) {
    return { mode: "catchup", reason: "peers" };
  }
  if (s.headersTotal <= 0 || s.headersDownloaded < s.headersTotal) {
    return { mode: "catchup", reason: "headers" };
  }
  if (s.filterMissingRangeCount > 0 && s.filterWorkNeedsPeers) {
    return { mode: "catchup", reason: "peers" };
  }
  if (s.filterMissingRangeCount > 0) {
    return { mode: "catchup", reason: "filters" };
  }
  if (
    s.needingDownloadCount > 0 ||
    s.blocksDownloaded < s.blocksMatched
  ) {
    return { mode: "catchup", reason: "blocks" };
  }
  return { mode: "idle" };
}
