import { describe, expect, test } from "bun:test";
import { config } from "../../src/config.ts";

describe("config", () => {
  test("exposes fixed app settings", () => {
    expect(config).toEqual({
      peerProbeTimeoutMs: 3_000,
      headerSyncTimeoutMs: 30_000,
      headerRacePeers: 10,
      peerConcurrency: 30,
      filterSyncTimeoutMs: 120_000,
      filterConcurrency: 30,
      filterHeaderBatchSize: 2000,
      filterBatchSize: 1000,
      blockConnectTimeoutMs: 3_000,
      blockSyncTimeoutMs: 30_000,
      blockConcurrency: 30,
      gapLimit: 100,
      initialWatchCount: 100,
    });
  });
});
