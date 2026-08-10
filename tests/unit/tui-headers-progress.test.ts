import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { checkpointDbRecord, checkpointSeedRecord } from "../../src/checkpoint.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createChainHeadersModule } from "../../src/modules/chain-headers.ts";
import { createBlocksMatchedStore } from "../../src/tui/blocks-matched-store.ts";
import { createFiltersProgressStore } from "../../src/tui/filters-progress-store.ts";
import { createHeadersProgressStore } from "../../src/tui/headers-progress-store.ts";
import { createMatchingProgressStore } from "../../src/tui/matching-progress-store.ts";
import { createPeerSocketsStore } from "../../src/tui/peer-sockets-store.ts";
import { createModuleStatusStore } from "../../src/tui/status-store.ts";
import { createTuiModule } from "../../src/tui/tui-module.ts";
import { createWalletTxsStore } from "../../src/tui/wallet-txs-store.ts";
import { stubPlatformNet } from "./stub-platform-net.ts";

describe("TUI headers progress wiring", () => {
  test("applies headers:progress events to the store", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const headersProgressStore = createHeadersProgressStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerSocketsStore(),
      headersProgressStore,
      createFiltersProgressStore(),
      createMatchingProgressStore(),
      createBlocksMatchedStore(),
      createWalletTxsStore(),
    );
    tui.start();
    bus.emit("headers:progress", {
      at: 1000,
      downloaded: 50,
      total: 200,
      height: 548_402,
    });
    expect(headersProgressStore.get()).toMatchObject({
      downloaded: 50,
      total: 200,
      height: 548_402,
      at: 1000,
      percent: 25,
    });
    tui.stop();
    db.close();
  });

  test("chain-headers start does not clobber DB-seeded progress with 0/0", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());

    const headersProgressStore = createHeadersProgressStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerSocketsStore(),
      headersProgressStore,
      createFiltersProgressStore(),
      createMatchingProgressStore(),
      createBlocksMatchedStore(),
      createWalletTxsStore(),
    );
    tui.start();
    const seeded = headersProgressStore.get();
    expect(seeded.downloaded).toBeGreaterThan(0);
    expect(seeded.total).toBeGreaterThan(0);
    expect(seeded.height).toBe(seed.height);

    const headers = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        connectTimeoutMs: 50,
        headersTimeoutMs: 50,
        pollIntervalMs: 10_000,
        fetchBatch: async () => ({
          ok: true,
          startHeight: 0,
          headers: [],
        }),
      },
    );
    await headers.start();

    const after = headersProgressStore.get();
    expect(after.downloaded).toBe(seeded.downloaded);
    expect(after.total).toBe(seeded.total);
    expect(after.percent).toBe(seeded.percent);

    await headers.stop();
    tui.stop();
    db.close();
  });
});
