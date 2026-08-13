import { describe, expect, test } from "bun:test";
import { encodeBlockHeader } from "bitcoin-headers";
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
  test("hydrates headers from DB; payload total > 0 only; zeros do not clobber", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.headers.append([
      {
        height: 10,
        hashInternalHex: "aa".repeat(32),
        header: encodeBlockHeader({
          version: 1,
          previousBlockHash: new Uint8Array(32),
          merkleRoot: new Uint8Array(32),
          timestamp: 1,
          bits: 0x1d00ffff,
          nonce: 0,
        }),
        cumulativeWork: 10n,
      },
      {
        height: 11,
        hashInternalHex: "bb".repeat(32),
        header: encodeBlockHeader({
          version: 1,
          previousBlockHash: new Uint8Array(32),
          merkleRoot: new Uint8Array(32),
          timestamp: 2,
          bits: 0x1d00ffff,
          nonce: 0,
        }),
        cumulativeWork: 11n,
      },
    ]);
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
    expect(headersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 1,
      height: 11,
    });
    bus.emit("headers:progress", {
      at: 1000,
      downloaded: 0,
      total: 0,
      height: 0,
    });
    expect(headersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 1,
      height: 11,
    });
    bus.emit("headers:progress", {
      at: 2000,
      downloaded: 999,
      total: 500,
      height: 1,
    });
    expect(headersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 500,
      height: 11,
      at: 2000,
    });
    tui.stop();
    db.close();
  });

  test("chain-headers start does not clobber DB-seeded progress with 0/0", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    const base = db.headers.tip()!.cumulativeWork;
    db.headers.append([
      {
        height: seed.height + 1,
        hashInternalHex: "aa".repeat(32),
        header: encodeBlockHeader({
          version: 1,
          previousBlockHash: new Uint8Array(32),
          merkleRoot: new Uint8Array(32),
          timestamp: 1,
          bits: 0x1d00ffff,
          nonce: 0,
        }),
        cumulativeWork: base + 1n,
      },
    ]);

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
    expect(seeded.height).toBe(seed.height + 1);
    expect(seeded.downloaded).toBe(1);
    expect(seeded.total).toBe(1);

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
