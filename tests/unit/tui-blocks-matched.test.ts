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
  test("blocks:progress and filters:match hydrate counts from DB", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.matchedBlocks.insert({
      height: 1,
      blockHashInternalHex: "11".repeat(32),
    });
    db.matchedBlocks.insert({
      height: 2,
      blockHashInternalHex: "22".repeat(32),
    });
    db.blocks.insert({
      height: 1,
      blockHashInternalHex: "11".repeat(32),
      block: new Uint8Array([1]),
    });
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
    expect(blocksMatchedStore.get()).toMatchObject({
      downloaded: 1,
      matched: 2,
    });
    bus.emit("blocks:progress", {
      at: 1,
      downloaded: 3,
      matched: 15,
    });
    expect(blocksMatchedStore.get()).toMatchObject({
      downloaded: 1,
      matched: 2,
      at: 1,
    });
    db.blocks.insert({
      height: 2,
      blockHashInternalHex: "22".repeat(32),
      block: new Uint8Array([2]),
    });
    bus.emit("filters:match", {
      height: 2,
      blockHashInternalHex: "22".repeat(32),
    });
    expect(blocksMatchedStore.get()).toMatchObject({
      downloaded: 2,
      matched: 2,
    });
    tui.stop();
    db.close();
  });
});
