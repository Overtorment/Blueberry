import { describe, expect, test } from "bun:test";
import {
  bytesToHex,
  equalBytes,
  hexToBytes,
  NODE_COMPACT_FILTERS,
} from "bip157";
import { filterHash, filterHeader } from "bip158";
import {
  decodeCompactTarget,
  encodeBlockHeader,
  headerHashInternal,
  hashToUint256,
  storedHeaderFromBlockHeader,
  type BlockHeader,
  type HeaderRecord,
} from "bitcoin-headers";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import type { FilterSessionApi } from "../../src/net/filter-sync.ts";
import {
  createFiltersDownloadModule,
  type FiltersDownloadOptions,
} from "../../src/modules/filters-download.ts";
import {
  markWalletBirthdayPending,
  maybeFreezeWalletBirthday,
} from "../../src/wallet/birthday.ts";
import { stubPlatformNet } from "./stub-platform-net.ts";

const EASY_BITS = 0x207fffff;
const EASY_LIMIT = decodeCompactTarget(EASY_BITS, (1n << 256n) - 1n);

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

function mineHeader(options: {
  previousHash?: Uint8Array;
  bits: number;
  timestamp: number;
  marker: number;
}): BlockHeader {
  const target = decodeCompactTarget(options.bits, EASY_LIMIT);
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

/** Unique-hash header without PoW grinding — filters-download never checks PoW. */
function fakeRecord(height: number, previousHash: Uint8Array): HeaderRecord {
  const merkleRoot = new Uint8Array(32);
  new DataView(merkleRoot.buffer).setUint32(0, height >>> 0, true);
  return record(height, {
    version: 1,
    previousBlockHash: previousHash.slice(),
    merkleRoot,
    timestamp: 1_234_567 + height,
    bits: EASY_BITS,
    nonce: height,
  });
}

function buildFilterChain(
  heights: number[],
  bootstrapPrev: Uint8Array,
): {
  filterBytesByHeight: Map<number, Uint8Array>;
  filterHashesByHeight: Map<number, Uint8Array>;
  filterHeaderByHeight: Map<number, Uint8Array>;
} {
  const filterBytesByHeight = new Map<number, Uint8Array>();
  const filterHashesByHeight = new Map<number, Uint8Array>();
  const filterHeaderByHeight = new Map<number, Uint8Array>();
  let prev = bootstrapPrev;
  for (const height of heights) {
    const fb = new Uint8Array([height & 0xff, (height >> 8) & 0xff, 0xab]);
    const fh = new Uint8Array(filterHash(fb));
    const header = new Uint8Array(filterHeader(fh, prev));
    filterBytesByHeight.set(height, fb);
    filterHashesByHeight.set(height, fh);
    filterHeaderByHeight.set(height, header);
    prev = header;
  }
  return { filterBytesByHeight, filterHashesByHeight, filterHeaderByHeight };
}

/** Heights 0–1000 so genesis can bind against the first BIP157 checkpoint. */
function buildGenesisFixture(): FilterFixture {
  const headers: HeaderRecord[] = [];
  let prevHash: Uint8Array = new Uint8Array(32);
  for (let h = 0; h <= 1000; h++) {
    const rec = fakeRecord(h, prevHash);
    headers.push(rec);
    prevHash = hexToBytes(rec.hashInternalHex);
  }
  const bootstrapPrev = new Uint8Array(32);
  const chain = buildFilterChain(
    headers.map((row) => row.height),
    bootstrapPrev,
  );
  return {
    from: 0,
    to: 1000,
    headers,
    bootstrapPrev,
    ...chain,
  };
}

function dbHeaderWrites(records: HeaderRecord[]) {
  return records.map((r) => ({
    height: r.height,
    hashInternalHex: r.hashInternalHex,
    header: hexToBytes(r.headerHex),
  }));
}

type FilterFixture = {
  from: number;
  to: number;
  headers: HeaderRecord[];
  bootstrapPrev: Uint8Array;
  filterBytesByHeight: Map<number, Uint8Array>;
  filterHashesByHeight: Map<number, Uint8Array>;
  filterHeaderByHeight: Map<number, Uint8Array>;
};

/** Heights 998–1000 with checkpoint at 1000 for cfheaders auth. */
function buildFilterFixture(): FilterFixture {
  const h998 = mineHeader({
    bits: EASY_BITS,
    timestamp: 1_998,
    marker: 98,
  });
  const h999 = mineHeader({
    previousHash: headerHashInternal(h998),
    bits: EASY_BITS,
    timestamp: 1_999,
    marker: 99,
  });
  const h1000 = mineHeader({
    previousHash: headerHashInternal(h999),
    bits: EASY_BITS,
    timestamp: 2_000,
    marker: 100,
  });

  const headers = [
    record(998, h998),
    record(999, h999),
    record(1000, h1000),
  ];

  const bootstrapPrev = new Uint8Array(32).fill(0x11);
  const chain = buildFilterChain([998, 999, 1000], bootstrapPrev);

  return {
    from: 998,
    to: 1000,
    headers,
    bootstrapPrev,
    ...chain,
  };
}

function seedPeer(db: ReturnType<typeof createSqliteDatabase>): void {
  db.peers.upsert({
    host: "1.1.1.1",
    port: 8333,
    services: BigInt(NODE_COMPACT_FILTERS),
    alive: true,
    usedForBlocks: false,
    lastProbedAt: null,
  });
}

function createScriptedSession(
  fixture: FilterFixture,
  options?: {
    badHeight?: number;
    onOpen?: () => void;
    holdCfilt?: Promise<void>;
    holdCfHeaders?: Promise<void>;
  },
): FilterSessionApi {
  options?.onOpen?.();
  const {
    headers,
    bootstrapPrev,
    filterBytesByHeight,
    filterHashesByHeight,
    filterHeaderByHeight,
  } = fixture;

  return {
    services: BigInt(NODE_COMPACT_FILTERS),
    async getCFCheckpt() {
      const tip = headers[headers.length - 1]!;
      const count = Math.floor(tip.height / 1000);
      const out: Uint8Array[] = [];
      for (let i = 1; i <= count; i++) {
        const header = filterHeaderByHeight.get(i * 1000);
        out.push(header ? header.slice() : new Uint8Array(32));
      }
      return out;
    },
    async getCFHeaders(startHeight, stopHash) {
      if (options?.holdCfHeaders) await options.holdCfHeaders;
      const stopHeight = headers.find(
        (h) => h.hashInternalHex === bytesToHex(stopHash),
      )!.height;
      const filterHashes: Uint8Array[] = [];
      for (let h = startHeight; h <= stopHeight; h++) {
        filterHashes.push(filterHashesByHeight.get(h)!.slice());
      }
      const previousFilterHeader =
        startHeight === fixture.from
          ? bootstrapPrev.slice()
          : filterHeaderByHeight.get(startHeight - 1)!.slice();
      return {
        filterType: 0,
        stopHash: stopHash.slice(),
        previousFilterHeader,
        filterHashes,
      };
    },
    async getCFilters(startHeight, stopHash, expectCount, onFilter) {
      if (options?.holdCfilt) await options.holdCfilt;
      const stopHeight = headers.find(
        (h) => h.hashInternalHex === bytesToHex(stopHash),
      )!.height;
      const out: Array<{ blockHash: Uint8Array; filterBytes: Uint8Array }> = [];
      for (let h = startHeight; h <= stopHeight; h++) {
        const row = headers.find((r) => r.height === h)!;
        let fb = filterBytesByHeight.get(h)!;
        if (options?.badHeight === h) {
          fb = new Uint8Array([0xff]);
        }
        const item = {
          blockHash: hexToBytes(row.hashInternalHex),
          filterBytes: fb,
        };
        out.push(item);
        if (onFilter) await onFilter(item);
      }
      expect(out.length).toBe(expectCount);
      return out;
    },
    close() {},
  };
}

function makeOpenSession(
  fixture: FilterFixture,
  options?: {
    badHeight?: number;
    onOpen?: () => void;
  },
): FiltersDownloadOptions["openSession"] {
  return async () => {
    return {
      ok: true,
      value: createScriptedSession(fixture, options),
    };
  };
}

describe("filters-download", () => {
  test("busy kick does not double-start; dirty bit re-runs after", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    let releaseCfilt!: () => void;
    const cfiltHeld = new Promise<void>((resolve) => {
      releaseCfilt = resolve;
    });

    let sessionOpened = false;
    const downloadRuns = { count: 0 };

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        idleDelayMs: 50,
        onDownloadRun: () => {
          downloadRuns.count++;
        },
        openSession: async () => ({
          ok: true,
          value: createScriptedSession(fixture, {
            onOpen: () => {
              sessionOpened = true;
            },
            holdCfilt: cfiltHeld,
          }),
        }),
      },
    );

    await mod.start();
    await waitFor(() => sessionOpened);
    bus.emit("headers:progress", {
      at: Date.now(),
      downloaded: 1,
      total: 1,
      height: 1,
    });
    bus.emit("headers:progress", {
      at: Date.now(),
      downloaded: 2,
      total: 2,
      height: 2,
    });
    expect(downloadRuns.count).toBe(1);
    releaseCfilt();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    await waitFor(() => downloadRuns.count >= 2);
    await mod.stop();
    db.close();
  });

  test("idle kick resumes when tip grows", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers.slice(0, 2)));
    seedPeer(db);

    const downloadRuns = { count: 0 };
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        idleDelayMs: 50,
        onDownloadRun: () => {
          downloadRuns.count++;
        },
        openSession: makeOpenSession(fixture),
      },
    );

    await mod.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(db.filters.countInRange(fixture.from, fixture.to)).toBe(0);

    db.headers.append(dbHeaderWrites(fixture.headers.slice(2)));
    bus.emit("headers:progress", {
      at: Date.now(),
      downloaded: 3,
      total: 3,
      height: 3,
    });
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(downloadRuns.count).toBeGreaterThanOrEqual(1);
    await mod.stop();
    db.close();
  });

  test("emits filters:progress with downloaded and total", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const progress: Array<{ downloaded: number; total: number }> = [];
    bus.on("filters:progress", (p) => {
      progress.push({ downloaded: p.downloaded, total: p.total });
    });

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        openSession: makeOpenSession(fixture),
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(progress.some((p) => p.downloaded === 3 && p.total === 3)).toBe(true);
    await mod.stop();
    db.close();
  });

  test("rejects bad filter bytes and tries another peer", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: BigInt(NODE_COMPACT_FILTERS),
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    db.peers.upsert({
      host: "2.2.2.2",
      port: 8333,
      services: BigInt(NODE_COMPACT_FILTERS),
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    const openedHosts: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        coolMs: 60_000,
        openSession: async (host) => {
          openedHosts.push(host);
          return {
            ok: true,
            value: createScriptedSession(fixture, {
              badHeight: host === "1.1.1.1" ? 999 : undefined,
            }),
          };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(openedHosts).toContain("1.1.1.1");
    expect(openedHosts).toContain("2.2.2.2");
    await mod.stop();
    db.close();
  });

  test("rejects duplicate cfilter messages from a peer", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const lines: string[] = [];
    let opens = 0;
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        persistBatchSize: 1,
        coolMs: 1,
        log: (line) => lines.push(line),
        openSession: async () => {
          opens++;
          const base = createScriptedSession(fixture);
          if (opens > 1) return { ok: true, value: base };
          return {
            ok: true,
            value: {
              ...base,
              async getCFilters(startHeight, stopHash, expectCount, onFilter) {
                const filters = await base.getCFilters(
                  startHeight,
                  stopHash,
                  expectCount,
                );
                const duplicate = filters[0]!;
                for (let i = 0; i < expectCount; i++) {
                  if (onFilter) await onFilter(duplicate);
                }
                return Array.from({ length: expectCount }, () => duplicate);
              },
            },
          };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(
      lines.some(
        (line) =>
          line.includes("filter batch failure") &&
          line.includes("duplicate cfilter height"),
      ),
    ).toBe(true);
    await mod.stop();
    db.close();
  });

  test("persists bootstrap prev at from-1 when from > 0", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        openSession: makeOpenSession(fixture),
      },
    );

    await mod.start();
    await waitFor(() => db.filters.has(fixture.to));
    expect(db.filterHeaders.get(fixture.from - 1)?.header).toEqual(
      fixture.bootstrapPrev,
    );
    await mod.stop();
    db.close();
  });

  test("discards in-flight cfheaders after reorg replaces stop hash", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    const forkTip = mineHeader({
      previousHash: hexToBytes(fixture.headers[1]!.hashInternalHex),
      bits: EASY_BITS,
      timestamp: 2_100,
      marker: 120,
    });
    const forkRecord = record(1000, forkTip);

    db.headers.append(dbHeaderWrites(fixture.headers));
    maybeFreezeWalletBirthday(db, fixture.from);
    seedPeer(db);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        idleDelayMs: 20,
        openSession: async () => ({
          ok: true,
          value: createScriptedSession(fixture, { holdCfHeaders: held }),
        }),
      },
    );

    await mod.start();
    await new Promise((r) => setTimeout(r, 60));

    db.transaction(() => {
      db.rewindAfter(999);
      db.headers.replaceAfter(999, [
        {
          height: forkRecord.height,
          hashInternalHex: forkRecord.hashInternalHex,
          header: hexToBytes(forkRecord.headerHex),
        },
      ]);
    });
    expect(db.filterHeaders.tip()).toBeNull();

    release();
    await new Promise((r) => setTimeout(r, 120));

    expect(db.filterHeaders.get(1000)).toBeNull();
    expect(db.filterHeaders.tip()).toBeNull();

    await mod.stop();
    db.close();
  });

  test("discards in-flight cfilters for heights replaced by a reorg", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    const forkTip = mineHeader({
      previousHash: hexToBytes(fixture.headers[1]!.hashInternalHex),
      bits: EASY_BITS,
      timestamp: 2_100,
      marker: 121,
    });
    const forkRecord = record(1000, forkTip);

    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        idleDelayMs: 20,
        openSession: async () => ({
          ok: true,
          value: createScriptedSession(fixture, { holdCfilt: held }),
        }),
      },
    );

    await mod.start();
    // Filter headers complete, then getCFilters is held in flight.
    await waitFor(() => db.filterHeaders.get(1000) !== null);
    await new Promise((r) => setTimeout(r, 40));

    db.transaction(() => {
      db.rewindAfter(999);
      db.headers.replaceAfter(999, [
        {
          height: forkRecord.height,
          hashInternalHex: forkRecord.hashInternalHex,
          header: hexToBytes(forkRecord.headerHex),
        },
      ]);
    });
    expect(db.filters.maxHeight()).toBeNull();

    release();
    await new Promise((r) => setTimeout(r, 120));

    // 998/999 are still canonical; 1000 was replaced and must not persist.
    expect(db.filters.get(998)).not.toBeNull();
    expect(db.filters.get(999)).not.toBeNull();
    expect(db.filters.get(1000)).toBeNull();

    await mod.stop();
    db.close();
  });

  test("rejects bootstrap first batch without in-range checkpoint", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const lines: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 1,
        headerBatchSize: 1,
        idleDelayMs: 20,
        log: (line) => lines.push(line),
        openSession: async () => ({
          ok: true,
          value: {
            ...createScriptedSession(fixture),
            async getCFHeaders(startHeight, stopHash) {
              const base = await createScriptedSession(fixture).getCFHeaders(
                startHeight,
                stopHash,
              );
              return {
                ...base,
                previousFilterHeader: new Uint8Array(32).fill(0xee),
              };
            },
          },
        }),
      },
    );

    await mod.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(db.filterHeaders.get(fixture.from)).toBeNull();
    expect(db.filters.count()).toBe(0);
    await mod.stop();
    expect(
      lines.some((line) =>
        /header batch failure range=998-1000 peer=1\.1\.1\.1:8333 elapsedMs=\d+ error=.*cfheaders verification failed/.test(
          line,
        ),
      ),
    ).toBe(true);
    db.close();
  });

  test("retries after cfilter EOF once cool elapses", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    let calls = 0;
    const lines: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        idleDelayMs: 20,
        coolMs: 1,
        log: (line) => lines.push(line),
        openSession: async () => {
          calls++;
          if (calls === 1) {
            return {
              ok: true,
              value: {
                ...createScriptedSession(fixture),
                async getCFilters() {
                  throw new Error("unexpected EOF");
                },
              },
            };
          }
          return { ok: true, value: createScriptedSession(fixture) };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(calls).toBeGreaterThanOrEqual(2);
    await mod.stop();
    expect(
      lines.some((line) =>
        /filter batch failure range=998-1000 peer=1\.1\.1\.1:8333 received=0 saved=0 bytes=0 elapsedMs=\d+ error=.*unexpected EOF/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        /filter batch retry range=998-1000 failure=1\/9 action=requeue/.test(
          line,
        ),
      ),
    ).toBe(true);
    db.close();
  });

  test("persists verified filters before an incomplete batch fails", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    let opens = 0;
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        persistBatchSize: 3,
        coolMs: 60_000,
        openSession: async () => {
          opens++;
          if (opens > 1) return { ok: false, error: "still cooling" };
          const base = createScriptedSession(fixture);
          return {
            ok: true,
            value: {
              ...base,
              async getCFilters(startHeight, stopHash, expectCount, onFilter) {
                const filters = await base.getCFilters(
                  startHeight,
                  stopHash,
                  expectCount,
                );
                for (const item of filters.slice(0, 2)) {
                  if (onFilter) await onFilter(item);
                }
                throw new Error("unexpected EOF");
              },
            },
          };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 2);
    expect(db.filters.has(998)).toBe(true);
    expect(db.filters.has(999)).toBe(true);
    expect(db.filters.has(1000)).toBe(false);
    await mod.stop();
    db.close();
  });

  test("logs network and persistence errors when final partial flush fails", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const append = db.filters.append.bind(db.filters);
    let failNextAppend = true;
    db.filters.append = (rows) => {
      if (failNextAppend) {
        failNextAppend = false;
        throw new Error("disk full");
      }
      append(rows);
    };

    const lines: string[] = [];
    let opens = 0;
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        persistBatchSize: 3,
        coolMs: 1,
        log: (line) => lines.push(line),
        openSession: async () => {
          opens++;
          const base = createScriptedSession(fixture);
          if (opens > 1) return { ok: true, value: base };
          return {
            ok: true,
            value: {
              ...base,
              async getCFilters(startHeight, stopHash, expectCount, onFilter) {
                const filters = await base.getCFilters(
                  startHeight,
                  stopHash,
                  expectCount,
                );
                for (const item of filters.slice(0, 2)) {
                  if (onFilter) await onFilter(item);
                }
                throw new Error("unexpected EOF");
              },
            },
          };
        },
      },
    );

    await mod.start();
    await waitFor(() =>
      lines.some(
        (line) =>
          line.includes("error=unexpected EOF") &&
          line.includes("persistenceError=disk full"),
      ),
    );
    await mod.stop();
    db.close();
  });

  test("retries only the unpersisted tail of a partial batch", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const requests: Array<{ start: number; count: number }> = [];
    let opens = 0;
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        persistBatchSize: 2,
        coolMs: 1,
        openSession: async () => {
          opens++;
          const base = createScriptedSession(fixture);
          if (opens === 1) {
            return {
              ok: true,
              value: {
                ...base,
                async getCFilters(
                  startHeight,
                  stopHash,
                  expectCount,
                  onFilter,
                ) {
                  requests.push({ start: startHeight, count: expectCount });
                  const filters = await base.getCFilters(
                    startHeight,
                    stopHash,
                    expectCount,
                  );
                  for (const item of filters.slice(0, 2)) {
                    if (onFilter) await onFilter(item);
                  }
                  throw new Error("unexpected EOF");
                },
              },
            };
          }
          return {
            ok: true,
            value: {
              ...base,
              async getCFilters(
                startHeight,
                stopHash,
                expectCount,
                onFilter,
              ) {
                requests.push({ start: startHeight, count: expectCount });
                return base.getCFilters(
                  startHeight,
                  stopHash,
                  expectCount,
                  onFilter,
                );
              },
            },
          };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(requests.slice(0, 2)).toEqual([
      { start: 998, count: 3 },
      { start: 1000, count: 1 },
    ]);
    await mod.stop();
    db.close();
  });

  test("requests first bootstrap batch through next checkpoint", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const requestedStops: number[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 3,
        headerBatchSize: 3,
        openSession: async () => ({
          ok: true,
          value: {
            ...createScriptedSession(fixture),
            async getCFHeaders(startHeight, stopHash) {
              const stopHeight = fixture.headers.find(
                (h) => h.hashInternalHex === bytesToHex(stopHash),
              )!.height;
              requestedStops.push(stopHeight);
              return createScriptedSession(fixture).getCFHeaders(
                startHeight,
                stopHash,
              );
            },
          },
        }),
      },
    );

    await mod.start();
    await waitFor(() => db.filters.has(fixture.to));
    expect(requestedStops[0]).toBe(1000);
    await mod.stop();
    db.close();
  });

  test("two-phase: cfheaders complete before cfilters", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const order: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        openSession: async () => ({
          ok: true,
          value: {
            ...createScriptedSession(fixture),
            async getCFHeaders(startHeight, stopHash) {
              order.push("cfheaders");
              return createScriptedSession(fixture).getCFHeaders(
                startHeight,
                stopHash,
              );
            },
            async getCFilters(startHeight, stopHash, expectCount) {
              order.push("cfilters");
              return createScriptedSession(fixture).getCFilters(
                startHeight,
                stopHash,
                expectCount,
              );
            },
          },
        }),
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(order.indexOf("cfheaders")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("cfilters")).toBeGreaterThan(
      order.indexOf("cfheaders"),
    );
    await mod.stop();
    db.close();
  });

  test("internal filter holes do not report downloaded > total", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);
    db.filterHeaders.append([
      { height: fixture.from - 1, header: fixture.bootstrapPrev.slice() },
      ...[...fixture.filterHeaderByHeight.entries()].map(([height, header]) => ({
        height,
        header: header.slice(),
      })),
    ]);
    // Bodies at 998 and 1000 only — hole at 999.
    db.filters.append([
      {
        height: fixture.from,
        blockHashInternalHex: fixture.headers[0]!.hashInternalHex,
        filter: fixture.filterBytesByHeight.get(fixture.from)!.slice(),
      },
      {
        height: fixture.to,
        blockHashInternalHex: fixture.headers[2]!.hashInternalHex,
        filter: fixture.filterBytesByHeight.get(fixture.to)!.slice(),
      },
    ]);

    const progress: Array<{ downloaded: number; total: number }> = [];
    bus.on("filters:progress", (p) => {
      progress.push({ downloaded: p.downloaded, total: p.total });
    });

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        openSession: async () => ({
          ok: true,
          value: {
            ...createScriptedSession(fixture),
            async getCFHeaders() {
              throw new Error("headers already present");
            },
          },
        }),
      },
    );

    await mod.start();
    await waitFor(
      () => db.filters.countInRange(fixture.from, fixture.to) === 3,
    );
    await mod.stop();

    for (const p of progress) {
      expect(p.downloaded).toBeLessThanOrEqual(p.total);
    }
    // Correct while gapped (span math would falsely seed 3/3).
    expect(progress.some((p) => p.downloaded === 2 && p.total === 3)).toBe(true);
    expect(progress.at(-1)).toEqual({ downloaded: 3, total: 3 });
    db.close();
  });

  test("backfills filters when filter headers already exist", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    db.filterHeaders.append([
      { height: fixture.from - 1, header: fixture.bootstrapPrev.slice() },
      ...[...fixture.filterHeaderByHeight.entries()].map(([height, header]) => ({
        height,
        header: header.slice(),
      })),
    ]);

    let cfHeadersCalls = 0;
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        openSession: async () => ({
          ok: true,
          value: {
            ...createScriptedSession(fixture),
            async getCFHeaders() {
              cfHeadersCalls++;
              throw new Error("headers already present");
            },
          },
        }),
      },
    );

    await mod.start();
    await waitFor(
      () => db.filters.countInRange(fixture.from, fixture.to) === 3,
    );
    expect(cfHeadersCalls).toBe(0);
    await mod.stop();
    db.close();
  });

  test("falls back to stored compact-filter peers when none are alive", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    db.peers.upsert({
      host: "9.9.9.9",
      port: 8333,
      services: BigInt(NODE_COMPACT_FILTERS),
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    const openedHosts: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        openSession: async (host) => {
          openedHosts.push(host);
          return { ok: true, value: createScriptedSession(fixture) };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(openedHosts[0]).toBe("9.9.9.9");
    expect(db.peers.listAlive().some((p) => p.host === "9.9.9.9")).toBe(true);
    await mod.stop();
    db.close();
  });

  test("retries session-dead peers and marks them alive on success", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    db.peers.upsert({
      host: "8.8.8.8",
      port: 8333,
      services: BigInt(NODE_COMPACT_FILTERS),
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let opens = 0;
    const lines: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        idleDelayMs: 20,
        coolMs: 1,
        log: (line) => lines.push(line),
        openSession: async () => {
          opens++;
          if (opens === 1) {
            return { ok: false, error: "boom" };
          }
          return { ok: true, value: createScriptedSession(fixture) };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    expect(opens).toBeGreaterThanOrEqual(2);
    expect(db.peers.listAlive().some((p) => p.host === "8.8.8.8")).toBe(true);
    await mod.stop();
    expect(
      lines.some((line) =>
        /session open failure peer=8\.8\.8\.8:8333 elapsedMs=\d+ cooldownMs=1 error=boom/.test(
          line,
        ),
      ),
    ).toBe(true);
    db.close();
  });

  test("pending wallet birthday downloads no filters", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);
    markWalletBirthdayPending(db);

    let sessionOpened = false;
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        idleDelayMs: 30,
        openSession: async () => {
          sessionOpened = true;
          return { ok: true, value: createScriptedSession(fixture) };
        },
      },
    );
    await mod.start();
    await new Promise((r) => setTimeout(r, 120));
    expect(sessionOpened).toBe(false);
    expect(db.filters.count()).toBe(0);
    await mod.stop();
    db.close();
  });

  test("frozen birthday skips cfilters below that height", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);
    markWalletBirthdayPending(db);
    expect(maybeFreezeWalletBirthday(db, 1000)).toBe(true);

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        idleDelayMs: 50,
        openSession: makeOpenSession(fixture),
      },
    );
    await mod.start();
    await waitFor(() => db.filters.has(1000));
    expect(db.filters.has(998)).toBe(false);
    expect(db.filters.has(999)).toBe(false);
    expect(db.filters.has(1000)).toBe(true);
    await mod.stop();
    db.close();
  });

  test("reorg at birthday checkpoint reuses bootstrap prev instead of re-inserting it", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    const forkTip = mineHeader({
      previousHash: hexToBytes(fixture.headers[1]!.hashInternalHex),
      bits: EASY_BITS,
      timestamp: 2_200,
      marker: 130,
    });
    const forkRecord = record(1000, forkTip);
    const forkFilterBytes = new Uint8Array([0xde, 0xad, 0xab]);
    const forkFilterHash = new Uint8Array(filterHash(forkFilterBytes));
    const prev999 = fixture.filterHeaderByHeight.get(999)!;
    const forkFilterHeader = new Uint8Array(
      filterHeader(forkFilterHash, prev999),
    );
    const forkFixture: FilterFixture = {
      ...fixture,
      headers: [fixture.headers[0]!, fixture.headers[1]!, forkRecord],
      filterBytesByHeight: new Map([
        ...fixture.filterBytesByHeight,
        [1000, forkFilterBytes],
      ]),
      filterHashesByHeight: new Map([
        ...fixture.filterHashesByHeight,
        [1000, forkFilterHash],
      ]),
      filterHeaderByHeight: new Map([
        ...fixture.filterHeaderByHeight,
        [1000, forkFilterHeader],
      ]),
    };

    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);
    markWalletBirthdayPending(db);
    expect(maybeFreezeWalletBirthday(db, 1000)).toBe(true);

    let useFork = false;
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        idleDelayMs: 20,
        coolMs: 1,
        openSession: async () => ({
          ok: true,
          value: createScriptedSession(useFork ? forkFixture : fixture),
        }),
      },
    );

    await mod.start();
    await waitFor(() => db.filterHeaders.get(1000) !== null);
    expect(db.filterHeaders.get(999)?.header).toEqual(prev999);

    db.transaction(() => {
      db.rewindAfter(999);
      db.headers.replaceAfter(999, [
        {
          height: forkRecord.height,
          hashInternalHex: forkRecord.hashInternalHex,
          header: hexToBytes(forkRecord.headerHex),
        },
      ]);
    });
    useFork = true;
    bus.emit("headers:progress", {
      at: Date.now(),
      downloaded: 3,
      total: 3,
      height: 1000,
    });

    await waitFor(
      () =>
        db.filterHeaders.get(1000) !== null &&
        equalBytes(db.filterHeaders.get(1000)!.header, forkFilterHeader),
    );
    expect(db.filterHeaders.get(999)?.header).toEqual(prev999);
    await mod.stop();
    db.close();
  });

  test("while sync:idle, peers:updated does not start a new download run", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const downloadRuns = { count: 0 };
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        idleDelayMs: 50,
        onDownloadRun: () => {
          downloadRuns.count++;
        },
        openSession: makeOpenSession(fixture),
      },
    );
    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    const runsAfterSync = downloadRuns.count;
    bus.emit("sync:idle", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    bus.emit("peers:updated", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    expect(downloadRuns.count).toBe(runsAfterSync);
    await mod.stop();
    db.close();
  });

  test("logs successful filter batches with peer metrics", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const lines: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        openSession: makeOpenSession(fixture),
        log: (line) => lines.push(line),
      },
    );

    await mod.start();
    await waitFor(() => db.filters.countInRange(fixture.from, fixture.to) === 3);
    await mod.stop();

    expect(
      lines.some((line) =>
        /filter batch success range=998-1000 peer=1\.1\.1\.1:8333 received=3 saved=3 bytes=9 elapsedMs=\d+/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        /filter queue range=998-1000 batches=1 missing=3/.test(line),
      ),
    ).toBe(true);
    expect(
      lines.some((line) =>
        /sync plan filterRange=998-1000 headerRange=998-1000 cached=0 peers=1/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(
      lines.some((line) => /run complete .*remaining=0/.test(line)),
    ).toBe(true);
    db.close();
  });

  test("authenticates genesis filter headers against checkpoint 1000, not height 0", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildGenesisFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    const lines: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 2000,
        headerBatchSize: 1,
        openSession: makeOpenSession(fixture),
        log: (line) => lines.push(line),
      },
    );

    await mod.start();
    await waitFor(() => db.filterHeaders.get(0) !== null, 10_000);
    expect(db.filterHeaders.get(1000)?.header).toEqual(
      fixture.filterHeaderByHeight.get(1000)!,
    );
    await mod.stop();
    expect(
      lines.some((line) =>
        /header batch success range=0-1000/.test(line),
      ),
    ).toBe(true);
    db.close();
  }, 15_000);

  test("fills prefix filter holes while still behind the header tip", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    const h1001 = fakeRecord(
      1001,
      hexToBytes(fixture.headers[2]!.hashInternalHex),
    );
    const filter1001Bytes = new Uint8Array([0x01, 0x04, 0xab]);
    const filter1001Hash = new Uint8Array(filterHash(filter1001Bytes));
    const filter1001Header = new Uint8Array(
      filterHeader(filter1001Hash, fixture.filterHeaderByHeight.get(1000)!),
    );

    db.headers.append(dbHeaderWrites([...fixture.headers, h1001]));
    seedPeer(db);
    db.filterHeaders.append([
      { height: fixture.from - 1, header: fixture.bootstrapPrev.slice() },
      ...[...fixture.filterHeaderByHeight.entries()].map(([height, header]) => ({
        height,
        header: header.slice(),
      })),
      { height: 1001, header: filter1001Header.slice() },
    ]);
    db.filters.append([
      {
        height: fixture.from,
        blockHashInternalHex: fixture.headers[0]!.hashInternalHex,
        filter: fixture.filterBytesByHeight.get(fixture.from)!.slice(),
      },
      {
        height: fixture.to,
        blockHashInternalHex: fixture.headers[2]!.hashInternalHex,
        filter: fixture.filterBytesByHeight.get(fixture.to)!.slice(),
      },
    ]);

    const extended: FilterFixture = {
      ...fixture,
      to: 1001,
      headers: [...fixture.headers, h1001],
      filterBytesByHeight: new Map([
        ...fixture.filterBytesByHeight,
        [1001, filter1001Bytes],
      ]),
      filterHashesByHeight: new Map([
        ...fixture.filterHashesByHeight,
        [1001, filter1001Hash],
      ]),
      filterHeaderByHeight: new Map([
        ...fixture.filterHeaderByHeight,
        [1001, filter1001Header],
      ]),
    };

    const lines: string[] = [];
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        openSession: makeOpenSession(extended),
        log: (line) => lines.push(line),
      },
    );

    await mod.start();
    await waitFor(() => db.filters.has(999) && db.filters.has(1001));
    await mod.stop();
    expect(
      lines.some((line) =>
        /filter queue range=998-1001 batches=2 missing=2/.test(line),
      ),
    ).toBe(true);
    db.close();
  });

  test("progress totals stay on the birthday filter range during header sync", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);
    markWalletBirthdayPending(db);
    expect(maybeFreezeWalletBirthday(db, 999)).toBe(true);

    const totals = new Set<number>();
    bus.on("filters:progress", (p) => {
      totals.add(p.total);
    });

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        filterBatchSize: 10,
        headerBatchSize: 3,
        openSession: makeOpenSession(fixture),
      },
    );

    await mod.start();
    await waitFor(() => db.filters.has(1000));
    await mod.stop();
    // filterFrom=999 → total=2. Header chainFrom=998 must not leak total=3.
    expect(totals.has(2)).toBe(true);
    expect(totals.has(3)).toBe(false);
    db.close();
  });

  test("stop() waits for an in-flight download run to finish", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(dbHeaderWrites(fixture.headers));
    seedPeer(db);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = false;

    const mod = createFiltersDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        concurrency: 1,
        idleDelayMs: 20,
        openSession: async () => {
          const base = createScriptedSession(fixture);
          return {
            ok: true,
            value: {
              ...base,
              async getCFilters(startHeight, stopHash, expectCount, onFilter) {
                inFlight = true;
                try {
                  await held;
                  return await base.getCFilters(
                    startHeight,
                    stopHash,
                    expectCount,
                    onFilter,
                  );
                } finally {
                  inFlight = false;
                }
              },
              close() {
                release();
              },
            },
          };
        },
      },
    );

    await mod.start();
    await waitFor(() => inFlight);
    await mod.stop();
    expect(inFlight).toBe(false);
    db.close();
  });
});
