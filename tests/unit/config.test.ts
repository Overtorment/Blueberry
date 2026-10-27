import { describe, expect, test } from "bun:test";
import { config } from "../../src/config.ts";

describe("config", () => {
  test("exposes fixed app settings", () => {
    expect(config).toEqual({
      peerProbeTimeoutMs: 60_000,
      peerAddrTimeoutMs: 3_000,
      peerCrawlIntervalMs: 15_000,
      headerSyncTimeoutMs: 30_000,
      headerRacePeers: 3,
      headerIdleCheckMs: 10 * 60 * 1_000,
      peerConcurrency: 8,
      filterSyncTimeoutMs: 30_000,
      filterConcurrency: 3,
      filterHeaderBatchSize: 2000,
      filterBatchSize: 100,
      blockConnectTimeoutMs: 60_000,
      blockSyncTimeoutMs: 30_000,
      blockConcurrency: 3,
      gapLimit: 100,
      initialWatchCount: 100,
    });
  });
});
