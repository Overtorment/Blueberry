import { describe, expect, test } from "bun:test";
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

describe("TUI blocks progress wiring", () => {
  test("applies blocks:progress from the bus", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const blocksMatchedStore = createBlocksMatchedStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerSocketsStore(),
      createHeadersProgressStore(),
      createFiltersProgressStore(),
      createMatchingProgressStore(),
      blocksMatchedStore,
      createWalletTxsStore(),
    );
    tui.start();

    bus.emit("blocks:progress", {
      at: 1,
      downloaded: 3,
      matched: 15,
    });
    expect(blocksMatchedStore.get()).toMatchObject({
      downloaded: 3,
      matched: 15,
      at: 1,
      percent: 20,
    });

    tui.stop();
    db.close();
  });
});
