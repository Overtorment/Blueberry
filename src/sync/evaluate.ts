import type { SyncEvaluation, SyncSnapshot } from "./types.ts";

export function evaluateSyncState(s: SyncSnapshot): SyncEvaluation {
  const headersBehind =
    s.headersTotal <= 0 || s.headersDownloaded < s.headersTotal;
  const filtersBehind = s.filterMissingRangeCount > 0;
  const blocksBehind =
    s.needingDownloadCount > 0 || s.blocksDownloaded < s.blocksMatched;
  const needsNetwork = headersBehind || filtersBehind || blocksBehind;

  if (needsNetwork && s.alivePeerCount === 0) {
    return { mode: "catchup", reason: "peers" };
  }
  if (headersBehind) {
    return { mode: "catchup", reason: "headers" };
  }
  if (filtersBehind && s.filterWorkNeedsPeers) {
    return { mode: "catchup", reason: "peers" };
  }
  if (filtersBehind) {
    return { mode: "catchup", reason: "filters" };
  }
  if (blocksBehind) {
    return { mode: "catchup", reason: "blocks" };
  }
  return { mode: "idle" };
}
