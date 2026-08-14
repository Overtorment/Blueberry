import { describe, expect, test } from "bun:test";
import { evaluateSyncState } from "../../src/sync/evaluate.ts";
import type { SyncSnapshot } from "../../src/sync/types.ts";

function base(over: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    headersDownloaded: 100,
    headersTotal: 100,
    filterMissingRangeCount: 0,
    filterWorkNeedsPeers: false,
    blocksDownloaded: 5,
    blocksMatched: 5,
    needingDownloadCount: 0,
    alivePeerCount: 3,
    ...over,
  };
}

describe("evaluateSyncState", () => {
  test("caught up → idle", () => {
    expect(evaluateSyncState(base())).toEqual({ mode: "idle" });
  });

  test("priority: no peers wins over headers behind", () => {
    expect(
      evaluateSyncState(
        base({ alivePeerCount: 0, headersDownloaded: 90, headersTotal: 100 }),
      ),
    ).toEqual({ mode: "catchup", reason: "peers" });
  });

  test("locally complete with no peers → idle", () => {
    expect(evaluateSyncState(base({ alivePeerCount: 0 }))).toEqual({
      mode: "idle",
    });
  });

  test("unknown or behind tip → headers", () => {
    expect(evaluateSyncState(base({ headersTotal: 0 }))).toEqual({
      mode: "catchup",
      reason: "headers",
    });
    expect(
      evaluateSyncState(base({ headersDownloaded: 90, headersTotal: 100 })),
    ).toEqual({ mode: "catchup", reason: "headers" });
  });

  test("filter gaps → filters; thin CF pool → peers", () => {
    expect(
      evaluateSyncState(base({ filterMissingRangeCount: 2 })),
    ).toEqual({ mode: "catchup", reason: "filters" });
    expect(
      evaluateSyncState(
        base({ filterMissingRangeCount: 2, filterWorkNeedsPeers: true }),
      ),
    ).toEqual({ mode: "catchup", reason: "peers" });
  });

  test("pending or in-flight blocks → blocks", () => {
    expect(
      evaluateSyncState(base({ needingDownloadCount: 1 })),
    ).toEqual({ mode: "catchup", reason: "blocks" });
    expect(
      evaluateSyncState(
        base({ needingDownloadCount: 0, blocksDownloaded: 4, blocksMatched: 5 }),
      ),
    ).toEqual({ mode: "catchup", reason: "blocks" });
  });
});
