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

describe("TUI matching progress", () => {
  test("applyEvent updates get() before any subscribe", () => {
    const store = createMatchingProgressStore();
    store.applyEvent({ at: 1000, scanned: 340250, total: 412390 });
    expect(store.get()).toMatchObject({
      scanned: 340250,
      total: 412390,
      percent: 82,
    });
  });

  test("subscribe after applyEvent still sees seeded values", () => {
    const store = createMatchingProgressStore();
    store.applyEvent({ at: 1000, scanned: 10, total: 100 });
    const before = store.get();
    let seen = 0;
    const unsub = store.subscribe(() => {
      seen++;
    });
    // Same reference — useSyncExternalStore loops if subscribe reallocates.
    expect(store.get()).toBe(before);
    expect(store.get()).toMatchObject({ scanned: 10, total: 100 });
    expect(seen).toBe(0);
    unsub();
  });

  test("get() keeps referential equality when values unchanged", () => {
    const store = createMatchingProgressStore();
    store.applyEvent({ at: 1000, scanned: 10, total: 100 });
    const a = store.get();
    store.applyEvent({ at: 1000, scanned: 10, total: 100 });
    expect(store.get()).toBe(a);
  });

  test("seeds from DB on tui start and applies matching:progress", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 1,
        blockHashInternalHex: "11".repeat(32),
        filter: hexToBytes("aa"),
      },
      {
        height: 2,
        blockHashInternalHex: "22".repeat(32),
        filter: hexToBytes("bb"),
      },
    ]);
    db.filters.markScanned([1]);
    const matchingProgressStore = createMatchingProgressStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerSocketsStore(),
      createHeadersProgressStore(),
      createFiltersProgressStore(),
      matchingProgressStore,
      createBlocksMatchedStore(),
      createWalletTxsStore(),
    );
    tui.start();
    expect(matchingProgressStore.get()).toMatchObject({
      scanned: 1,
      total: 2,
      percent: 50,
    });
    bus.emit("matching:progress", {
      at: 2000,
      scanned: 2,
      total: 2,
    });
    expect(matchingProgressStore.get()).toMatchObject({
      scanned: 1,
      total: 2,
      percent: 50,
    });
    db.filters.markScanned([2]);
    bus.emit("matching:progress", {
      at: 3000,
      scanned: 0,
      total: 0,
    });
    expect(matchingProgressStore.get()).toMatchObject({
      scanned: 2,
      total: 2,
      percent: 100,
      at: 3000,
    });
    tui.stop();
    db.close();
  });

  test("ETA ignores seed→first-progress dead time", () => {
    const store = createMatchingProgressStore();
    // Seed (TUI start) — long gap before matching actually advances.
    store.applyEvent({ at: 1000, scanned: 1000, total: 5000 });
    expect(store.get().etaMs).toBeNull();
    // First advance after 120s idle must not arm lifetime rate from seed.
    store.applyEvent({ at: 121_000, scanned: 1100, total: 5000 });
    expect(store.get().etaMs).toBeNull();
    // Steady 100 filters / 100ms → 1/ms; remaining 3800 → 3800ms
    store.applyEvent({ at: 121_100, scanned: 1200, total: 5000 });
    expect(store.get().etaMs).toBe(3800);
  });

  test("ETA ignores completion→idle dead time when matching resumes", () => {
    const store = createMatchingProgressStore();
    store.applyEvent({ at: 1000, scanned: 500, total: 1000 });
    store.applyEvent({ at: 2000, scanned: 1000, total: 1000 });
    expect(store.get().etaMs).toBe(0);

    // More filters arrive after a long idle; percent drops below 100.
    store.applyEvent({ at: 1_000_000, scanned: 1000, total: 5000 });
    expect(store.get().percent).toBe(20);
    expect(store.get().etaMs).toBeNull();

    store.applyEvent({ at: 1_001_000, scanned: 1100, total: 5000 });
    expect(store.get().etaMs).toBeNull();

    // Steady 100 / 1000ms from resume — not from completion timestamp.
    store.applyEvent({ at: 1_002_000, scanned: 1200, total: 5000 });
    expect(store.get().etaMs).toBe(38_000);
  });
});
