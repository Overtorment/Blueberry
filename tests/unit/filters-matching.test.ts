import { describe, expect, test } from "bun:test";
import { buildBasicFilter, hexToBytes } from "bip158";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createFiltersMatchingModule } from "../../src/modules/filters-matching.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import { createWallet } from "../../src/wallet/wallet.ts";
import { saveWatchGaps } from "../../src/wallet/watch-gaps.ts";

const ABANDON_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("timeout waiting for condition"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function internalHexToDisplay(internalHex: string): Uint8Array {
  const internal = hexToBytes(internalHex);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = internal[31 - i]!;
  return out;
}

function filterContaining(
  scripts: Uint8Array[],
  internalHex: string,
): Uint8Array {
  return buildBasicFilter({
    blockHashDisplay: internalHexToDisplay(internalHex),
    elements: scripts,
  });
}

function appendFilter(
  db: ReturnType<typeof createSqliteDatabase>,
  height: number,
  internalHex: string,
  scripts: Uint8Array[],
): void {
  db.filters.append([
    {
      height,
      blockHashInternalHex: internalHex,
      filter: filterContaining(scripts, internalHex),
    },
  ]);
}

function needsMatch(
  db: ReturnType<typeof createSqliteDatabase>,
  height: number,
): boolean {
  return db.filters.listNeedingMatch(64).some((f) => f.height === height);
}

describe("filters-matching", () => {
  test("hit on init emits match and marks scanned", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const hash = "11".repeat(32);
    appendFilter(db, 100, hash, [wallet.snapshot().addresses[0]!.scriptPubKey]);

    const hits: Array<{ height: number; blockHashInternalHex: string }> = [];
    bus.on("filters:match", (p) => hits.push(p));

    const mod = createFiltersMatchingModule(
      { bus, db },
      { wallet, batchGapMs: 0, yieldFn: async () => {} },
    );
    await mod.start();
    await waitFor(() => hits.length === 1 && !needsMatch(db, 100));
    expect(hits[0]).toEqual({ height: 100, blockHashInternalHex: hash });
    expect(db.matchedBlocks.count()).toBe(1);
    await mod.stop();
    db.close();
  });

  test("miss marks scanned without emitting", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const hash = "22".repeat(32);
    appendFilter(db, 200, hash, [
      new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]),
    ]);

    const hits: number[] = [];
    bus.on("filters:match", (p) => hits.push(p.height));

    const mod = createFiltersMatchingModule(
      { bus, db },
      { wallet, batchGapMs: 0, yieldFn: async () => {} },
    );
    await mod.start();
    await waitFor(() => !needsMatch(db, 200));
    expect(hits).toEqual([]);
    expect(db.matchedBlocks.count()).toBe(0);
    await mod.stop();
    db.close();
  });

  test("already scanned filter is skipped", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const hash = "33".repeat(32);
    appendFilter(db, 300, hash, [wallet.snapshot().addresses[0]!.scriptPubKey]);
    db.filters.markScanned([300]);

    const hits: number[] = [];
    bus.on("filters:match", (p) => hits.push(p.height));

    const mod = createFiltersMatchingModule(
      { bus, db },
      { wallet, batchGapMs: 0 },
    );
    await mod.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(hits).toEqual([]);
    expect(needsMatch(db, 300)).toBe(false);
    await mod.stop();
    db.close();
  });

  test("emits matching:progress on start and after each batch", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    appendFilter(db, 1, "01".repeat(32), [
      new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xcd)]),
    ]);
    db.filters.markScanned([1]);
    appendFilter(db, 2, "02".repeat(32), [
      new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xce)]),
    ]);
    appendFilter(db, 3, "03".repeat(32), [
      new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xcf)]),
    ]);

    const events: Array<{ scanned: number; total: number }> = [];
    bus.on("matching:progress", (p) => {
      events.push({ scanned: p.scanned, total: p.total });
    });

    const mod = createFiltersMatchingModule(
      { bus, db },
      {
        wallet,
        batchSize: 1,
        batchGapMs: 0,
        yieldFn: async () => {},
      },
    );
    await mod.start();
    expect(events[0]).toEqual({ scanned: 1, total: 3 });
    await waitFor(
      () => events.length >= 3 && db.filters.countScanned() === 3,
    );
    expect(events.map((e) => e.scanned)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.total === 3)).toBe(true);
    await mod.stop();
    db.close();
  });

  test("keeps matching while matched blocks still need download", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const junk = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]);
    appendFilter(db, 400, "11".repeat(32), [
      wallet.snapshot().addresses[0]!.scriptPubKey,
    ]);
    appendFilter(db, 401, "22".repeat(32), [junk]);

    const mod = createFiltersMatchingModule(
      { bus, db },
      {
        wallet,
        batchSize: 1,
        batchGapMs: 0,
        yieldFn: async () => {},
      },
    );
    await mod.start();
    await waitFor(() => db.matchedBlocks.count() === 1);
    await waitFor(() => !needsMatch(db, 401));
    expect(db.matchedBlocks.listNeedingDownload(10)).toHaveLength(1);
    await mod.stop();
    db.close();
  });

  test("idle filters:progress emits matching:progress with new total before scanning", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const junk = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]);
    appendFilter(db, 1, "01".repeat(32), [junk]);
    db.filters.markScanned([1]);

    const events: Array<{ scanned: number; total: number }> = [];
    bus.on("matching:progress", (p) => {
      events.push({ scanned: p.scanned, total: p.total });
    });

    const mod = createFiltersMatchingModule(
      { bus, db },
      { wallet, batchSize: 1, batchGapMs: 0, yieldFn: async () => {} },
    );
    await mod.start();
    await waitFor(() => events.length >= 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(events[0]).toEqual({ scanned: 1, total: 1 });

    appendFilter(db, 2, "02".repeat(32), [junk]);
    bus.emit("filters:progress", { at: 1, downloaded: 2, total: 2 });
    await waitFor(() => db.filters.countScanned() === 2);
    expect(events).toContainEqual({ scanned: 1, total: 2 });
    await mod.stop();
    db.close();
  });

  test("idle resumes on filters:progress; busy kick still drains new work", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const junkA = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xcd)]);
    const junkB = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xce)]);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = false;

    const mod = createFiltersMatchingModule(
      { bus, db },
      {
        wallet,
        batchSize: 1,
        batchGapMs: 0,
        yieldFn: async () => {
          if (!gated) {
            gated = true;
            await gate;
          }
        },
      },
    );
    await mod.start();
    await new Promise((r) => setTimeout(r, 30));

    appendFilter(db, 500, "55".repeat(32), [junkA]);
    bus.emit("filters:progress", { at: 1, downloaded: 1, total: 1 });
    await waitFor(() => gated);

    appendFilter(db, 501, "56".repeat(32), [junkB]);
    bus.emit("filters:progress", { at: 2, downloaded: 2, total: 2 });
    bus.emit("filters:progress", { at: 3, downloaded: 2, total: 2 });

    release();
    await waitFor(() => !needsMatch(db, 500) && !needsMatch(db, 501));
    expect(db.matchedBlocks.count()).toBe(0);
    await mod.stop();
    db.close();
  });

  test("re-derives watchlist when key_value gaps grow", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const expanded = deriveWatchWallet(ABANDON_MNEMONIC, 8);
    const index5External = expanded.addresses.find(
      (a) => !a.change && a.index === 5,
    )!;
    const hash = "66".repeat(32);
    appendFilter(db, 600, hash, [index5External.scriptPubKey]);

    const hits: Array<{ height: number; blockHashInternalHex: string }> = [];
    bus.on("filters:match", (p) => hits.push(p));

    const mod = createFiltersMatchingModule(
      { bus, db },
      { wallet, batchGapMs: 0, yieldFn: async () => {} },
    );
    await mod.start();
    await waitFor(() => !needsMatch(db, 600));
    expect(hits).toEqual([]);
    expect(db.matchedBlocks.count()).toBe(0);

    saveWatchGaps(db, { external: 8, internal: 4 });
    db.filters.markUnscanned([600]);
    bus.emit("filters:progress", { at: 1, downloaded: 1, total: 1 });

    await waitFor(() => hits.some((h) => h.height === 600));
    expect(hits[0]).toEqual({ height: 600, blockHashInternalHex: hash });
    expect(db.matchedBlocks.count()).toBe(1);
    await mod.stop();
    db.close();
  });

  test("gap growth during busy scan rematches after old scripts mark-scanned", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const expanded = deriveWatchWallet(ABANDON_MNEMONIC, 8);
    const index5 = expanded.addresses.find((a) => !a.change && a.index === 5)!;
    const hash = "77".repeat(32);
    appendFilter(db, 700, hash, [index5.scriptPubKey]);
    db.transactions.upsert({
      txid: "ab".repeat(32),
      height: 700,
      txIndex: 0,
      blockHashInternalHex: hash,
      tx: new Uint8Array([0x00]),
      netDeltaSats: 1,
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gated = false;
    const hits: number[] = [];
    bus.on("filters:match", (p) => hits.push(p.height));

    const mod = createFiltersMatchingModule(
      { bus, db },
      {
        wallet,
        batchGapMs: 0,
        yieldFn: async () => {
          if (!gated) {
            gated = true;
            await gate;
          }
        },
      },
    );
    await mod.start();
    await waitFor(() => gated);

    // Same sequence as parse-blocks growth (including shared-wallet refresh).
    saveWatchGaps(db, { external: 8, internal: 4 });
    wallet.refresh();
    db.filters.markUnscannedFrom(700);
    bus.emit("filters:progress", { at: 1, downloaded: 1, total: 1 });

    release();
    // In-flight scan aborts on gap change; next pass rematches with new scripts.
    await waitFor(() => hits.includes(700) && db.matchedBlocks.count() === 1);
    await mod.stop();
    db.close();
  });

  test("gap growth aborts in-flight scan instead of draining with stale scripts", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON_MNEMONIC, addressGap: 4 });
    const expanded = deriveWatchWallet(ABANDON_MNEMONIC, 8);
    const index5 = expanded.addresses.find((a) => !a.change && a.index === 5)!;
    const junk = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)]);

    for (let h = 1; h <= 30; h++) {
      appendFilter(db, h, h.toString(16).padStart(2, "0").repeat(32), [junk]);
    }
    const hitHash = "99".repeat(32);
    appendFilter(db, 31, hitHash, [index5.scriptPubKey]);
    db.transactions.upsert({
      txid: "ef".repeat(32),
      height: 1,
      txIndex: 0,
      blockHashInternalHex: "01".repeat(32),
      tx: new Uint8Array([0x00]),
      netDeltaSats: 1,
    });

    let yields = 0;
    let grown = false;
    let hit = false;
    bus.on("filters:match", (p) => {
      if (p.height === 31) hit = true;
    });

    const mod = createFiltersMatchingModule(
      { bus, db },
      {
        wallet,
        batchSize: 1,
        batchGapMs: 0,
        yieldFn: async () => {
          yields++;
          if (!grown && yields >= 2) {
            grown = true;
            saveWatchGaps(db, { external: 8, internal: 4 });
            wallet.refresh();
            db.filters.markUnscannedFrom(1);
            bus.emit("filters:progress", { at: 1, downloaded: 31, total: 31 });
          }
        },
      },
    );
    await mod.start();
    await waitFor(() => hit, 5000);
    // Stale pass would keep draining ~30 re-queued misses before rematching
    // (~60+ yields). Abort + rematch should hit with far fewer.
    expect(yields).toBeLessThan(45);
    await mod.stop();
    db.close();
  });
});
