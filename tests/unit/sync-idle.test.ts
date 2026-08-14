import { describe, expect, test } from "bun:test";
import { hexToBytes, NODE_COMPACT_FILTERS } from "bip157";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { checkpointDbRecord } from "../../src/checkpoint.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createSyncIdleModule } from "../../src/modules/sync-idle.ts";
import {
  markWalletBirthdayPending,
  maybeFreezeWalletBirthday,
} from "../../src/wallet/birthday.ts";

function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("timeout"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function seedCaughtUpDb(db: ReturnType<typeof createSqliteDatabase>) {
  db.peers.upsert({
    host: "1.1.1.1",
    port: 8333,
    services: BigInt(NODE_COMPACT_FILTERS),
    alive: true,
    usedForBlocks: false,
    lastProbedAt: null,
  });
  db.headers.ensureCheckpoint(checkpointDbRecord());
  const tip = db.headers.tip()!;
  db.filterHeaders.append([
    { height: tip.height, header: hexToBytes("11".repeat(32)) },
  ]);
  db.filters.append([
    {
      height: tip.height,
      blockHashInternalHex: tip.hashInternalHex,
      filter: hexToBytes("00"),
    },
  ]);
  return tip;
}

function growTipWithoutFilter(
  db: ReturnType<typeof createSqliteDatabase>,
  tip: { height: number },
) {
  db.headers.append([
    {
      height: tip.height + 1,
      hashInternalHex: "cd".repeat(32),
      header: hexToBytes("00".repeat(80)),
    },
  ]);
}

function spyListAliveLimits(db: ReturnType<typeof createSqliteDatabase>) {
  const limits: number[] = [];
  const orig = db.peers.listAliveWithServices.bind(db.peers);
  db.peers.listAliveWithServices = (bits, limit, options) => {
    limits.push(limit);
    return orig(bits, limit, options);
  };
  return limits;
}

/** Two consecutive idle evaluations are required before sync:idle. */
function enterIdle(bus: ReturnType<typeof createMessageBus>) {
  bus.emit("headers:progress", {
    at: Date.now(),
    downloaded: 1,
    total: 1,
    height: 1,
  });
  bus.emit("blocks:progress", { at: Date.now(), downloaded: 0, matched: 0 });
  bus.emit("filters:progress", { at: Date.now(), downloaded: 1, total: 1 });
  bus.emit("peers:updated", { at: Date.now() });
}

describe("sync-idle", () => {
  test("seeds headers from DB so restart can idle without headers:progress", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: BigInt(NODE_COMPACT_FILTERS),
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    db.headers.ensureCheckpoint(checkpointDbRecord());
    const cp = db.headers.tip()!;
    const tipHeight = cp.height + 1;
    const tipHash = "ab".repeat(32);
    db.headers.append([
      {
        height: tipHeight,
        hashInternalHex: tipHash,
        header: hexToBytes("00".repeat(80)),
      },
    ]);
    markWalletBirthdayPending(db);
    maybeFreezeWalletBirthday(db, tipHeight);
    db.filters.append([
      {
        height: tipHeight,
        blockHashInternalHex: tipHash,
        filter: hexToBytes("00"),
      },
    ]);

    const idles: number[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));
    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 20, minAliveCompactFilters: 1 },
    );
    await mod.start();
    await waitFor(() => idles.length >= 1);
    await mod.stop();
    db.close();
  });
  test("needs two idle evals; then emits once (no re-spam)", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    seedCaughtUpDb(db);

    const idles: number[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();

    // First idle-ready eval: streak=1, no emit yet.
    bus.emit("headers:progress", {
      at: Date.now(),
      downloaded: 1,
      total: 1,
      height: 1,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(idles.length).toBe(0);

    // Second: emit once.
    bus.emit("blocks:progress", { at: Date.now(), downloaded: 0, matched: 0 });
    await waitFor(() => idles.length === 1);

    bus.emit("peers:updated", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 30));
    expect(idles.length).toBe(1);

    await mod.stop();
    db.close();
  });

  test("idle → catchup:blocks when a matched block needs download", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const tip = seedCaughtUpDb(db);

    const idles: number[] = [];
    const catchups: string[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));
    bus.on("sync:catchup", (p) => catchups.push(p.reason));

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();
    enterIdle(bus);
    await waitFor(() => idles.length >= 1);

    db.matchedBlocks.insert({
      height: tip.height,
      blockHashInternalHex: tip.hashInternalHex,
    });
    // Wake via filters:match (no blocks:progress) — proves that subscription.
    bus.emit("filters:match", {
      height: tip.height,
      blockHashInternalHex: tip.hashInternalHex,
    });
    await waitFor(() => catchups.includes("blocks"));
    expect(catchups).toEqual(["blocks"]);

    await mod.stop();
    db.close();
  });

  test("birthday wallet idles when filters cover birthday→tip only", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: BigInt(NODE_COMPACT_FILTERS),
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    // Checkpoint + one newer header; filters only at tip (birthday).
    db.headers.ensureCheckpoint(checkpointDbRecord());
    const cp = db.headers.tip()!;
    const tipHeight = cp.height + 1;
    const tipHash = "ab".repeat(32);
    db.headers.append([
      {
        height: tipHeight,
        hashInternalHex: tipHash,
        header: hexToBytes("00".repeat(80)),
      },
    ]);
    markWalletBirthdayPending(db);
    maybeFreezeWalletBirthday(db, tipHeight);
    db.filterHeaders.append([
      { height: tipHeight, header: hexToBytes("11".repeat(32)) },
    ]);
    db.filters.append([
      {
        height: tipHeight,
        blockHashInternalHex: tipHash,
        filter: hexToBytes("00"),
      },
    ]);

    const idles: number[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));
    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();
    enterIdle(bus);
    await waitFor(() => idles.length >= 1);
    expect(idles.length).toBe(1);
    await mod.stop();
    db.close();
  });

  test("stays idle when last alive peer dies after local catch-up", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    seedCaughtUpDb(db);

    const idles: number[] = [];
    const catchups: string[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));
    bus.on("sync:catchup", (p) => catchups.push(p.reason));

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();
    enterIdle(bus);
    await waitFor(() => idles.length >= 1);

    db.peers.markAlive("1.1.1.1", 8333, false);
    bus.emit("peers:updated", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 40));
    expect(catchups).toEqual([]);

    await mod.stop();
    db.close();
  });

  test("idle → catchup:filters when tip advances without cfilters", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const tip = seedCaughtUpDb(db);

    const idles: number[] = [];
    const catchups: string[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));
    bus.on("sync:catchup", (p) => catchups.push(p.reason));

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();
    enterIdle(bus);
    await waitFor(() => idles.length >= 1);

    growTipWithoutFilter(db, tip);
    bus.emit("headers:progress", {
      at: Date.now(),
      downloaded: 1,
      total: 1,
      height: tip.height + 1,
    });
    await waitFor(() => catchups.includes("filters"));
    expect(catchups).toEqual(["filters"]);

    await mod.stop();
    db.close();
  });

  test("idle → catchup:peers when filter work meets a thin CF pool", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const tip = seedCaughtUpDb(db);

    const idles: number[] = [];
    const catchups: string[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));
    bus.on("sync:catchup", (p) => catchups.push(p.reason));

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 2 },
    );
    await mod.start();
    enterIdle(bus);
    await waitFor(() => idles.length >= 1);

    growTipWithoutFilter(db, tip);
    bus.emit("headers:progress", {
      at: Date.now(),
      downloaded: 1,
      total: 1,
      height: tip.height + 1,
    });
    await waitFor(() => catchups.includes("peers"));
    expect(catchups).toEqual(["peers"]);

    await mod.stop();
    db.close();
  });

  test("catchup skips match and peer-churn snapshots", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    seedCaughtUpDb(db);

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();

    const limits = spyListAliveLimits(db);
    for (let i = 0; i < 20; i++) {
      bus.emit("filters:match", {
        height: 1,
        blockHashInternalHex: "aa".repeat(32),
      });
      bus.emit("peers:updated", { at: Date.now() });
    }
    expect(limits).toEqual([]);

    await mod.stop();
    db.close();
  });

  test("catchup eval does not scan the compact-filter pool", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    seedCaughtUpDb(db);

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 16 },
    );
    await mod.start();

    const limits = spyListAliveLimits(db);
    bus.emit("headers:progress", {
      at: Date.now(),
      downloaded: 1,
      total: 1,
      height: 1,
    });
    expect(limits.includes(16)).toBe(false);

    await mod.stop();
    db.close();
  });
});

