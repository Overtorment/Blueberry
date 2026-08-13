import { describe, expect, test } from "bun:test";
import { hexToBytes } from "bip158";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createBlocksMatchedStore } from "../../src/tui/blocks-matched-store.ts";
import { createFiltersProgressStore } from "../../src/tui/filters-progress-store.ts";
import { createHeadersProgressStore } from "../../src/tui/headers-progress-store.ts";
import { createMatchingProgressStore } from "../../src/tui/matching-progress-store.ts";
import { createPeerSocketsStore } from "../../src/tui/peer-sockets-store.ts";
import { createModuleStatusStore } from "../../src/tui/status-store.ts";
import { createTuiModule } from "../../src/tui/tui-module.ts";
import { createWalletTxsStore } from "../../src/tui/wallet-txs-store.ts";

describe("TUI filters progress wiring", () => {
  test("identical applyEvent keeps snapshot identity", () => {
    const store = createFiltersProgressStore();
    store.applyEvent({ at: 1000, downloaded: 50, total: 200 });
    const snap = store.get();
    store.applyEvent({ at: 1000, downloaded: 50, total: 200 });
    expect(store.get()).toBe(snap);
  });

  test("hydrates filters from DB; payload total > 0 only; zeros do not clobber", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 1,
        blockHashInternalHex: "11".repeat(32),
        filter: hexToBytes("aa"),
      },
    ]);
    const filtersProgressStore = createFiltersProgressStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerSocketsStore(),
      createHeadersProgressStore(),
      filtersProgressStore,
      createMatchingProgressStore(),
      createBlocksMatchedStore(),
      createWalletTxsStore(),
    );
    tui.start();
    expect(filtersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 1,
    });
    bus.emit("filters:progress", {
      at: 500,
      downloaded: 0,
      total: 0,
    });
    expect(filtersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 1,
    });
    bus.emit("filters:progress", {
      at: 1000,
      downloaded: 50,
      total: 200,
    });
    expect(filtersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 200,
      at: 1000,
      percent: 0,
    });
    tui.stop();
    db.close();
  });
});
