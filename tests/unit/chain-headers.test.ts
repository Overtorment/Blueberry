import { describe, expect, test } from "bun:test";
import {
  bytesToHex,
  decodeBlockHeader,
  decodeCompactTarget,
  encodeBlockHeader,
  hashToUint256,
  headerHashDisplay,
  headerHashInternal,
  hexToBytes,
  storedHeaderFromBlockHeader,
  type BlockHeader,
  type HeaderConsensusParams,
  type HeaderRecord,
} from "bitcoin-headers";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { CHECKPOINT_HEIGHT, checkpointDbRecord, checkpointSeedRecord } from "../../src/checkpoint.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createChainHeadersModule } from "../../src/modules/chain-headers.ts";
import {
  inspectWalletBirthday,
  markWalletBirthdayPending,
} from "../../src/wallet/birthday.ts";
import { stubPlatformNet } from "./stub-platform-net.ts";

const EASY_BITS = 0x207fffff;
const EASY_LIMIT = decodeCompactTarget(EASY_BITS, (1n << 256n) - 1n);

function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
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

function mineHeader(options: {
  previousHash?: Uint8Array;
  bits: number;
  timestamp: number;
  marker: number;
  powLimit?: bigint;
}): BlockHeader {
  const target = decodeCompactTarget(
    options.bits,
    options.powLimit ?? EASY_LIMIT,
  );
  const header: BlockHeader = {
    version: options.marker,
    previousBlockHash: options.previousHash?.slice() ?? new Uint8Array(32),
    merkleRoot: new Uint8Array(32).fill(options.marker & 0xff),
    timestamp: options.timestamp,
    bits: options.bits,
    nonce: 0,
  };
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    header.nonce = nonce;
    if (hashToUint256(headerHashInternal(header)) <= target) return header;
  }
  throw new Error("unable to mine deterministic test header");
}

function record(height: number, header: BlockHeader): HeaderRecord {
  return storedHeaderFromBlockHeader(height, header);
}

/** Easy-difficulty chain long enough to reorg from height 1 with a heavier fork. */
function buildReorgFixture(): {
  params: HeaderConsensusParams;
  canonical: HeaderRecord[];
  heavierFork: BlockHeader[];
} {
  const checkpoint = mineHeader({
    bits: EASY_BITS,
    timestamp: 1_000,
    marker: 1,
    powLimit: EASY_LIMIT,
  });
  const params: HeaderConsensusParams = {
    powLimit: EASY_LIMIT,
    targetSpacingSeconds: 10,
    targetTimespanSeconds: 40,
    retargetInterval: 4,
    medianTimeSpan: 11,
    maxFutureSeconds: 7_200,
    checkpoint: {
      height: 0,
      headerBytes: encodeBlockHeader(checkpoint),
      hashDisplay: headerHashDisplay(checkpoint),
      previousTimestamps: [890, 900, 910, 920, 930, 940, 950, 960, 970, 980],
    },
  };

  let tip = checkpoint;
  const canonical: HeaderRecord[] = [record(0, checkpoint)];
  for (const [i, ts] of [1_010, 1_020, 1_040].entries()) {
    tip = mineHeader({
      previousHash: headerHashInternal(tip),
      bits: EASY_BITS,
      timestamp: ts,
      marker: i + 2,
      powLimit: EASY_LIMIT,
    });
    canonical.push(record(i + 1, tip));
  }

  // Fork after height 1 (canonical tip is height 3); three-header heavier branch.
  const forkParent = canonical[1]!;
  const forkA = mineHeader({
    previousHash: hexToBytes(forkParent.hashInternalHex),
    bits: EASY_BITS,
    timestamp: 1_030,
    marker: 20,
    powLimit: EASY_LIMIT,
  });
  const forkB = mineHeader({
    previousHash: headerHashInternal(forkA),
    bits: EASY_BITS,
    timestamp: 1_041,
    marker: 21,
    powLimit: EASY_LIMIT,
  });
  const forkC = mineHeader({
    previousHash: headerHashInternal(forkB),
    bits: EASY_BITS,
    timestamp: 1_051,
    marker: 22,
    powLimit: EASY_LIMIT,
  });

  return { params, canonical, heavierFork: [forkA, forkB, forkC] };
}

describe("chain-headers", () => {
  test("waits for peers, appends a real mainnet header, emits progress", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const events: Array<{ downloaded: number; total: number }> = [];
    bus.on("headers:progress", (p) => {
      events.push({ downloaded: p.downloaded, total: p.total });
    });

    // Real mainnet header at 556417 (links from default checkpoint 556416).
    const nextHeader = decodeBlockHeader(
      hexToBytes(
        "000000208fdfeffd2c3a3a235a847805dbd1dc5adb9cd48519532a000000000000000000105b6f8cba2f1258ea4c1e41f72e843c770c3acfede6f02df3108c6fba7b88bfca4f2a5ca5183217d6a930c9",
      ),
    );

    let calls = 0;
    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        connectTimeoutMs: 200,
        headersTimeoutMs: 200,
        pollIntervalMs: 50,
        fetchBatch: async () => {
          calls++;
          if (calls === 1) {
            return {
              ok: true,
              startHeight: CHECKPOINT_HEIGHT + 100,
              headers: [nextHeader],
            };
          }
          return { ok: true, startHeight: CHECKPOINT_HEIGHT + 100, headers: [] };
        },
      },
    );

    await mod.start();
    expect(db.headers.count()).toBe(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toBe(0);

    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    bus.emit("peers:updated", { at: Date.now() });
    await waitFor(
      () =>
        db.headers.tip()?.height === CHECKPOINT_HEIGHT + 1 &&
        events.some((e) => e.downloaded === 1 && e.total === 100),
    );
    expect(db.headers.tip()?.hashInternalHex).toBe(
      bytesToHex(headerHashInternal(nextHeader)),
    );
    // Empty follow-up clamps the inflated handshake tip to local tip.
    await waitFor(() => {
      const last = events.at(-1);
      return last?.downloaded === 1 && last.total === 1;
    });
    expect(events.at(-1)).toEqual({ downloaded: 1, total: 1 });
    await mod.stop();
    db.close();
  });

  test("hard fetch failure tries peers, marks them not alive, emits peers:updated", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    for (const host of ["1.1.1.1", "2.2.2.2"]) {
      db.peers.upsert({
        host,
        port: 8333,
        services: 0n,
        alive: true,
        usedForBlocks: false,
        lastProbedAt: null,
      });
    }
    const tried: string[] = [];
    let peerUpdates = 0;
    bus.on("peers:updated", () => {
      peerUpdates++;
    });
    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        racePeers: 1,
        connectTimeoutMs: 100,
        headersTimeoutMs: 100,
        pollIntervalMs: 10_000,
        fetchBatch: async (host) => {
          tried.push(host);
          return { ok: false, error: "dead" };
        },
      },
    );
    await mod.start();
    await waitFor(() => tried.length >= 2 && peerUpdates >= 2);
    expect(new Set(tried)).toEqual(new Set(["1.1.1.1", "2.2.2.2"]));
    expect(db.peers.listAlive()).toHaveLength(0);
    await mod.stop();
    db.close();
  });

  test("races peers and takes the first ok batch", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    for (const host of ["slow.peer", "fast.peer"]) {
      db.peers.upsert({
        host,
        port: 8333,
        services: 0n,
        alive: true,
        usedForBlocks: false,
        lastProbedAt: null,
      });
    }

    const NEXT_HEADER_HEX =
      "000000208fdfeffd2c3a3a235a847805dbd1dc5adb9cd48519532a000000000000000000105b6f8cba2f1258ea4c1e41f72e843c770c3acfede6f02df3108c6fba7b88bfca4f2a5ca5183217d6a930c9";
    const nextHeader = decodeBlockHeader(hexToBytes(NEXT_HEADER_HEX));
    const started: string[] = [];
    let winner: string | undefined;
    let batches = 0;

    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        racePeers: 2,
        connectTimeoutMs: 500,
        headersTimeoutMs: 500,
        pollIntervalMs: 10_000,
        fetchBatch: async (host) => {
          started.push(host);
          if (batches > 0) {
            return {
              ok: true,
              startHeight: CHECKPOINT_HEIGHT + 100,
              headers: [],
            };
          }
          if (host === "slow.peer") {
            await new Promise((r) => setTimeout(r, 80));
            return {
              ok: true,
              startHeight: CHECKPOINT_HEIGHT + 100,
              headers: [nextHeader],
            };
          }
          await new Promise((r) => setTimeout(r, 5));
          winner = host;
          batches++;
          return {
            ok: true,
            startHeight: CHECKPOINT_HEIGHT + 100,
            headers: [nextHeader],
          };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.headers.tip()?.height === CHECKPOINT_HEIGHT + 1);
    expect(new Set(started)).toEqual(new Set(["fast.peer", "slow.peer"]));
    expect(winner).toBe("fast.peer");
    await mod.stop();
    db.close();
  });

  test("reorgs to a heavier fork via the sync loop", async () => {
    const { params, canonical, heavierFork } = buildReorgFixture();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.headers.append(
      canonical.map((r) => ({
        height: r.height,
        hashInternalHex: r.hashInternalHex,
        header: hexToBytes(r.headerHex),
      })),
    );

    const events: Array<{ downloaded: number; total: number }> = [];
    bus.on("headers:progress", (p) => {
      events.push({ downloaded: p.downloaded, total: p.total });
    });

    let calls = 0;
    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        consensus: params,
        connectTimeoutMs: 200,
        headersTimeoutMs: 200,
        pollIntervalMs: 50,
        nowSeconds: () => 10_000,
        fetchBatch: async () => {
          calls++;
          if (calls === 1) {
            return { ok: true, startHeight: 10, headers: heavierFork };
          }
          return { ok: true, startHeight: 10, headers: [] };
        },
      },
    );

    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    await mod.start();
    await waitFor(() => db.headers.tip()?.height === 4 && events.length >= 1);
    expect(db.headers.tip()?.hashInternalHex).toBe(
      bytesToHex(headerHashInternal(heavierFork[2]!)),
    );
    expect(db.headers.count()).toBe(5); // checkpoint + 4 on winning tip
    expect(events.at(-1)).toEqual({ downloaded: 4, total: 4 });
    await mod.stop();
    db.close();
  });

  test("stale peer startHeight does not report downloaded > total after tip advances", async () => {
    const { params, canonical } = buildReorgFixture();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.headers.append([
      {
        height: canonical[0]!.height,
        hashInternalHex: canonical[0]!.hashInternalHex,
        header: hexToBytes(canonical[0]!.headerHex),
      },
    ]);

    const events: Array<{ downloaded: number; total: number }> = [];
    bus.on("headers:progress", (p) => {
      events.push({ downloaded: p.downloaded, total: p.total });
    });

    const beyondTip = canonical.slice(1).map((r) =>
      decodeBlockHeader(hexToBytes(r.headerHex)),
    );
    let calls = 0;
    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        consensus: params,
        connectTimeoutMs: 200,
        headersTimeoutMs: 200,
        pollIntervalMs: 50,
        nowSeconds: () => 10_000,
        // startHeight stuck at 1 while peer still serves headers 1..3.
        fetchBatch: async () => {
          calls++;
          if (calls === 1) {
            return { ok: true, startHeight: 1, headers: beyondTip.slice(0, 1) };
          }
          if (calls === 2) {
            return { ok: true, startHeight: 1, headers: beyondTip.slice(1) };
          }
          return { ok: true, startHeight: 1, headers: [] };
        },
      },
    );

    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    await mod.start();
    await waitFor(() => db.headers.tip()?.height === 3 && events.length >= 2);
    await mod.stop();

    for (const ev of events) {
      expect(ev.downloaded).toBeLessThanOrEqual(ev.total);
    }
    expect(events.at(-1)).toEqual({ downloaded: 3, total: 3 });
    db.close();
  });

  test("backs off when every raced peer fails instantly", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    const callAt: number[] = [];
    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        racePeers: 1,
        connectTimeoutMs: 50,
        headersTimeoutMs: 50,
        pollIntervalMs: 10_000,
        fetchBatch: async () => {
          callAt.push(Date.now());
          return { ok: false, error: "session busy" };
        },
      },
    );
    await mod.start();
    await waitFor(() => callAt.length >= 3, 3000);
    await mod.stop();

    const gap1 = callAt[1]! - callAt[0]!;
    const gap2 = callAt[2]! - callAt[1]!;
    // Must not tight-loop (previously burned 100% CPU with ~0ms gaps).
    expect(gap1).toBeGreaterThanOrEqual(80);
    expect(gap2).toBeGreaterThanOrEqual(80);
    db.close();
  });

  test("backs off between empty header batches", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    const callAt: number[] = [];
    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        connectTimeoutMs: 100,
        headersTimeoutMs: 100,
        pollIntervalMs: 80,
        now: () => Date.now(),
        fetchBatch: async () => {
          callAt.push(Date.now());
          return {
            ok: true,
            startHeight: CHECKPOINT_HEIGHT + 100,
            headers: [],
          };
        },
      },
    );
    await mod.start();
    await waitFor(() => callAt.length >= 3);
    await mod.stop();

    const gap1 = callAt[1]! - callAt[0]!;
    const gap2 = callAt[2]! - callAt[1]!;
    expect(gap1).toBeGreaterThanOrEqual(70);
    expect(gap2).toBeGreaterThanOrEqual(70);
    db.close();
  });

  test("while sync:idle, peers:updated does not trigger fetchBatch", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let calls = 0;
    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        pollIntervalMs: 10_000,
        fetchBatch: async () => {
          calls++;
          return {
            ok: true as const,
            startHeight: db.headers.tip()!.height,
            headers: [],
          };
        },
      },
    );
    await mod.start();
    bus.emit("peers:updated", { at: Date.now() });
    await waitFor(() => calls >= 1);
    bus.emit("sync:idle", { at: Date.now() });
    const atIdle = calls;
    bus.emit("peers:updated", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(atIdle);
    await mod.stop();
    db.close();
  });

  test("does not freeze birthday while local tip is behind peer tip", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    markWalletBirthdayPending(db);
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    const nextHeader = decodeBlockHeader(
      hexToBytes(
        "000000208fdfeffd2c3a3a235a847805dbd1dc5adb9cd48519532a000000000000000000105b6f8cba2f1258ea4c1e41f72e843c770c3acfede6f02df3108c6fba7b88bfca4f2a5ca5183217d6a930c9",
      ),
    );

    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        pollIntervalMs: 10_000,
        fetchBatch: async () => ({
          ok: true as const,
          startHeight: CHECKPOINT_HEIGHT + 100,
          headers: [nextHeader],
        }),
      },
    );
    await mod.start();
    bus.emit("peers:updated", { at: Date.now() });
    await waitFor(() => db.headers.tip()?.height === CHECKPOINT_HEIGHT + 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(inspectWalletBirthday(db)).toEqual({ status: "pending" });
    await mod.stop();
    db.close();
  });

  test("freezes birthday at local tip once caught up to peer tip", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    markWalletBirthdayPending(db);
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    const nextHeader = decodeBlockHeader(
      hexToBytes(
        "000000208fdfeffd2c3a3a235a847805dbd1dc5adb9cd48519532a000000000000000000105b6f8cba2f1258ea4c1e41f72e843c770c3acfede6f02df3108c6fba7b88bfca4f2a5ca5183217d6a930c9",
      ),
    );

    const mod = createChainHeadersModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        pollIntervalMs: 10_000,
        fetchBatch: async () => ({
          ok: true as const,
          startHeight: CHECKPOINT_HEIGHT + 1,
          headers: [nextHeader],
        }),
      },
    );
    await mod.start();
    bus.emit("peers:updated", { at: Date.now() });
    await waitFor(() => inspectWalletBirthday(db).status === "ok");
    expect(inspectWalletBirthday(db)).toEqual({
      status: "ok",
      height: CHECKPOINT_HEIGHT + 1,
    });
    await mod.stop();
    db.close();
  });
});
