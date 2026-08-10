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

describe("peer sockets store", () => {
  test("merges kinds independently; clamps open; ignores no-ops", () => {
    const store = createPeerSocketsStore();
    let ticks = 0;
    store.subscribe(() => {
      ticks++;
    });

    store.applyEvent({ kind: "probe", open: 2 });
    store.applyEvent({ kind: "filt", open: 4 });
    store.applyEvent({ kind: "probe", open: 0 });
    expect(store.get()).toEqual({
      known: 0,
      probe: 0,
      hdr: 0,
      filt: 4,
      blk: 0,
    });

    store.applyEvent({ kind: "blk", open: -3 });
    expect(store.get().blk).toBe(0);

    const before = ticks;
    store.applyEvent({ kind: "filt", open: 4 });
    expect(ticks).toBe(before);
  });

  test("tui seeds known from DB and applies bus updates", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    const store = createPeerSocketsStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      store,
      createHeadersProgressStore(),
      createFiltersProgressStore(),
      createMatchingProgressStore(),
      createBlocksMatchedStore(),
      createWalletTxsStore(),
    );
    tui.start();
    expect(store.get().known).toBe(1);

    bus.emit("peers:sockets", { at: 1, kind: "hdr", open: 3 });
    expect(store.get().hdr).toBe(3);

    db.peers.upsert({
      host: "9.9.9.9",
      port: 8333,
      services: 1n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    bus.emit("peers:updated", { at: 2 });
    expect(store.get().known).toBe(2);

    tui.stop();
    db.close();
  });
});
