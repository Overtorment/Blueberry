import { describe, expect, test } from "bun:test";
import {
  bytesToHex,
  decodeBlock,
  encodeBlock,
  encodeBlockHeader,
  hexToBytes,
  sha256d,
  type BlockPayload,
} from "bip324";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  createBlocksDownloadModule,
  type BlocksDownloadOptions,
} from "../../src/modules/blocks-download.ts";
import type { BlockSessionApi } from "../../src/net/block-sync.ts";
import { stubPlatformNet } from "./stub-platform-net.ts";

const NODE_NETWORK = 1n;

/** Bitcoin genesis — real wire bytes for validation tests. */
const GENESIS_BLOCK_HEX =
  "01000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" +
  "29ab5f49ffff001d1dac2b7c" +
  "01" +
  "01000000" +
  "01" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "ffffffff" +
  "4d" +
  "04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73" +
  "ffffffff" +
  "01" +
  "00f2052a01000000" +
  "43" +
  "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac" +
  "00000000";

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

function internalHashHex(payload: BlockPayload): string {
  return bytesToHex(sha256d(encodeBlockHeader(payload.header)));
}

/** Distinct valid blocks: same txs, different nonce → different header hash. */
function makeVariantBlock(nonceDelta: number): BlockPayload {
  const genesis = decodeBlock(hexToBytes(GENESIS_BLOCK_HEX));
  return {
    header: { ...genesis.header, nonce: genesis.header.nonce + nonceDelta },
    transactions: genesis.transactions,
  };
}

function seedPeer(
  db: ReturnType<typeof createSqliteDatabase>,
  host: string,
): void {
  db.peers.upsert({
    host,
    port: 8333,
    services: NODE_NETWORK,
    alive: true,
    usedForBlocks: false,
    lastProbedAt: null,
  });
}

function makeOpenSession(
  blocksByInternalHex: Map<string, BlockPayload>,
  options?: {
    onOpen?: (host: string) => void;
    /** Return a block that fails assertBlockPayload for these internal hashes. */
    mismatchFor?: Set<string>;
    beforeGetBlock?: () => Promise<void>;
  },
): BlocksDownloadOptions["openSession"] {
  return async (host) => {
    options?.onOpen?.(host);
    const session: BlockSessionApi = {
      services: NODE_NETWORK,
      async getBlock(hashInternal) {
        if (options?.beforeGetBlock) await options.beforeGetBlock();
        const key = bytesToHex(hashInternal);
        if (options?.mismatchFor?.has(key)) {
          return decodeBlock(hexToBytes(GENESIS_BLOCK_HEX));
        }
        const payload = blocksByInternalHex.get(key);
        if (!payload) throw new Error(`no fixture for ${key}`);
        return payload;
      },
      close() {},
    };
    return { ok: true, value: session };
  };
}

describe("blocks-download", () => {
  test("start emits progress from DB; downloads, persists, marks peer used", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const block = makeVariantBlock(0);
    const internalHex = internalHashHex(block);

    db.matchedBlocks.insert({
      height: 0,
      blockHashInternalHex: internalHex,
    });
    seedPeer(db, "1.1.1.1");

    const events: Array<{ downloaded: number; matched: number }> = [];
    bus.on("blocks:progress", (p) => {
      events.push({ downloaded: p.downloaded, matched: p.matched });
    });

    const logs: string[] = [];
    const options: BlocksDownloadOptions & {
      log: (message: string) => void;
    } = {
      net: stubPlatformNet(),
      openSession: makeOpenSession(new Map([[internalHex, block]])),
      concurrency: 2,
      log: (message) => logs.push(message),
    };
    const mod = createBlocksDownloadModule(
      { bus, db },
      options,
    );
    await mod.start();
    expect(events[0]).toEqual({ downloaded: 0, matched: 1 });

    await waitFor(() => db.blocks.count() === 1);
    expect(db.blocks.get(0)).toEqual({
      height: 0,
      blockHashInternalHex: internalHex,
      block: new Uint8Array(encodeBlock(block)),
    });
    expect(db.peers.list()[0]!.usedForBlocks).toBe(true);
    expect(events.some((e) => e.downloaded === 1 && e.matched === 1)).toBe(
      true,
    );
    expect(
      logs.some(
        (line) =>
          line ===
          "module start concurrency=2 connectTimeoutMs=3000 syncTimeoutMs=30000",
      ),
    ).toBe(true);
    expect(logs).toContain("block start attempt=1 peer=1.1.1.1:8333");
    expect(
      logs.some((line) =>
        /^block success attempt=1 peer=1\.1\.1\.1:8333 bytes=\d+ elapsedMs=\d+$/.test(
          line,
        ),
      ),
    ).toBe(true);
    expect(logs.every((line) => !line.includes("height="))).toBe(true);

    await mod.stop();
    expect(logs).toContain("module stopped");
    db.close();
  });

  test("successful peer is never reused for another block", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const b0 = makeVariantBlock(0);
    const b1 = makeVariantBlock(1);
    const h0 = internalHashHex(b0);
    const h1 = internalHashHex(b1);

    db.matchedBlocks.insert({ height: 0, blockHashInternalHex: h0 });
    db.matchedBlocks.insert({ height: 1, blockHashInternalHex: h1 });
    seedPeer(db, "1.1.1.1");
    seedPeer(db, "2.2.2.2");

    const opened: string[] = [];
    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: makeOpenSession(
          new Map([
            [h0, b0],
            [h1, b1],
          ]),
          { onOpen: (host) => opened.push(host) },
        ),
        concurrency: 1,
      },
    );
    await mod.start();
    await waitFor(() => db.blocks.count() === 2);

    expect(opened).toHaveLength(2);
    expect(new Set(opened).size).toBe(2);
    expect(db.peers.list().every((p) => p.usedForBlocks)).toBe(true);

    await mod.stop();
    db.close();
  });

  test("idle resumes on filters:match", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const block = makeVariantBlock(0);
    const internalHex = internalHashHex(block);
    seedPeer(db, "1.1.1.1");

    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: makeOpenSession(new Map([[internalHex, block]])),
        concurrency: 1,
      },
    );
    await mod.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(db.blocks.count()).toBe(0);

    db.matchedBlocks.insert({
      height: 0,
      blockHashInternalHex: internalHex,
    });
    bus.emit("filters:match", {
      height: 0,
      blockHashInternalHex: internalHex,
    });
    await waitFor(() => db.blocks.count() === 1);

    await mod.stop();
    db.close();
  });

  test("idle picks up a new match even if the kick is lost", async () => {
    // Regresses shared-wake clobber: Promise.race leftover timers used to
    // clear the idle waiter so filters:match became a no-op.
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const b0 = makeVariantBlock(0);
    const b1 = makeVariantBlock(1);
    const h0 = internalHashHex(b0);
    const h1 = internalHashHex(b1);

    db.matchedBlocks.insert({ height: 0, blockHashInternalHex: h0 });
    seedPeer(db, "1.1.1.1");
    seedPeer(db, "2.2.2.2");

    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: makeOpenSession(
          new Map([
            [h0, b0],
            [h1, b1],
          ]),
        ),
        concurrency: 1,
      },
    );
    await mod.start();
    await waitFor(() => db.blocks.count() === 1);

    // Insert without emitting filters:match — must still download via poll.
    db.matchedBlocks.insert({ height: 1, blockHashInternalHex: h1 });
    await waitFor(() => db.blocks.count() === 2, 5000);

    await mod.stop();
    db.close();
  });

  test("in-flight download does not block a later match", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const b0 = makeVariantBlock(0);
    const b1 = makeVariantBlock(1);
    const h0 = internalHashHex(b0);
    const h1 = internalHashHex(b1);

    db.matchedBlocks.insert({ height: 0, blockHashInternalHex: h0 });
    seedPeer(db, "1.1.1.1");
    seedPeer(db, "2.2.2.2");

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;

    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: makeOpenSession(
          new Map([
            [h0, b0],
            [h1, b1],
          ]),
          {
            beforeGetBlock: async () => {
              inFlight++;
              await held;
            },
          },
        ),
        concurrency: 1,
      },
    );
    await mod.start();
    await waitFor(() => inFlight === 1);
    expect(db.blocks.count()).toBe(0);

    db.matchedBlocks.insert({ height: 1, blockHashInternalHex: h1 });
    bus.emit("filters:match", {
      height: 1,
      blockHashInternalHex: h1,
    });
    expect(db.blocks.count()).toBe(0);

    release();
    await waitFor(() => db.blocks.count() === 2);

    await mod.stop();
    db.close();
  });

  test("failed downloads retry under concurrency until complete", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const blocks = Array.from({ length: 8 }, (_, i) => makeVariantBlock(i));
    const fixtures = new Map(
      blocks.map((b) => [internalHashHex(b), b] as const),
    );
    for (let i = 0; i < blocks.length; i++) {
      db.matchedBlocks.insert({
        height: i,
        blockHashInternalHex: internalHashHex(blocks[i]!),
      });
      seedPeer(db, `${i + 1}.${i + 1}.${i + 1}.${i + 1}`);
    }

    const attempts = new Map<string, number>();
    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: async (host, port) => {
          const base = makeOpenSession(fixtures)!;
          const opened = await base(host, port, {
            connect: stubPlatformNet().connect,
          });
          if (!opened.ok) return opened;
          return {
            ok: true,
            value: {
              ...opened.value,
              async getBlock(hash) {
                const key = bytesToHex(hash);
                const n = (attempts.get(key) ?? 0) + 1;
                attempts.set(key, n);
                if (n === 1) throw new Error("transient");
                return opened.value.getBlock(hash);
              },
            },
          };
        },
        concurrency: 8,
      },
    );
    await mod.start();
    await waitFor(() => db.blocks.count() === 8, 10_000);
    expect(db.matchedBlocks.listNeedingDownload(10)).toEqual([]);
    await mod.stop();
    db.close();
  });

  test("keeps polling while pending remain (no bus kick required)", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const block = makeVariantBlock(0);
    const internalHex = internalHashHex(block);
    db.matchedBlocks.insert({
      height: 0,
      blockHashInternalHex: internalHex,
    });

    let allow = false;
    const logs: string[] = [];
    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: async (host, port) => {
          if (!allow) return { ok: false, error: "not yet" };
          return makeOpenSession(new Map([[internalHex, block]]))!(
            host,
            port,
            { connect: stubPlatformNet().connect },
          );
        },
        concurrency: 1,
        log: (message) => logs.push(message),
      },
    );
    await mod.start();
    await waitFor(() =>
      logs.includes(
        "queue stalled pending=1 inFlight=0 leasedPeers=0 coolingPeers=0",
      ),
    );
    seedPeer(db, "1.1.1.1");
    // Intentionally do NOT emit peers:updated / filters:match.
    expect(
      await waitFor(
        () =>
          logs.some((line) =>
            /^session open failure attempt=1 peer=1\.1\.1\.1:8333 elapsedMs=\d+ cooldownMs=3000 error=not yet$/.test(
              line,
            ),
          ),
        2000,
      ),
    ).toBeUndefined();
    allow = true;
    await waitFor(() => db.blocks.count() === 1, 5000);
    await mod.stop();
    db.close();
  });

  test("discards in-flight block after reorg replaces the match hash", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const orphan = makeVariantBlock(1);
    const orphanHex = internalHashHex(orphan);
    const replacement = makeVariantBlock(2);
    const replacementHex = internalHashHex(replacement);

    db.matchedBlocks.insert({
      height: 10,
      blockHashInternalHex: orphanHex,
    });
    seedPeer(db, "1.1.1.1");
    seedPeer(db, "2.2.2.2");

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: makeOpenSession(new Map([[orphanHex, orphan]]), {
          beforeGetBlock: async () => {
            await held;
          },
        }),
        concurrency: 1,
      },
    );
    await mod.start();
    await new Promise((r) => setTimeout(r, 40));

    db.rewindAfter(9);
    db.matchedBlocks.insert({
      height: 10,
      blockHashInternalHex: replacementHex,
    });
    release();
    await new Promise((r) => setTimeout(r, 80));

    expect(db.blocks.has(10)).toBe(false);
    expect(db.blocks.count()).toBe(0);

    await mod.stop();
    db.close();
  });

  test("hash mismatch: nothing persisted, peer not marked used", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const want = makeVariantBlock(1);
    const internalHex = internalHashHex(want);

    db.matchedBlocks.insert({
      height: 1,
      blockHashInternalHex: internalHex,
    });
    seedPeer(db, "1.1.1.1");

    let attempts = 0;
    const logs: string[] = [];
    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: makeOpenSession(new Map([[internalHex, want]]), {
          mismatchFor: new Set([internalHex]),
          beforeGetBlock: async () => {
            attempts++;
          },
        }),
        concurrency: 1,
        log: (message) => logs.push(message),
      },
    );
    await mod.start();
    await waitFor(() => attempts >= 1);
    await waitFor(() =>
      logs.some((line) =>
        /^block failure attempt=1 peer=1\.1\.1\.1:8333 phase=validate elapsedMs=\d+ cooldownMs=3000 error=/.test(
          line,
        ),
      ),
    );

    expect(db.blocks.count()).toBe(0);
    expect(db.peers.list()[0]!.usedForBlocks).toBe(false);
    expect(
      logs.some((line) =>
        /^block failure attempt=1 peer=1\.1\.1\.1:8333 phase=validate elapsedMs=\d+ cooldownMs=3000 error=/.test(
          line,
        ),
      ),
    ).toBe(true);

    await mod.stop();
    db.close();
  });

  test("openSession throw does not kill the download loop", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const block = makeVariantBlock(0);
    const internalHex = internalHashHex(block);
    db.matchedBlocks.insert({ height: 0, blockHashInternalHex: internalHex });
    seedPeer(db, "1.1.1.1");
    seedPeer(db, "2.2.2.2");

    const logs: string[] = [];
    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: async (host, port, opts) => {
          if (host === "1.1.1.1") throw new Error("connect exploded");
          return makeOpenSession(new Map([[internalHex, block]]))!(
            host,
            port,
            opts,
          );
        },
        concurrency: 1,
        log: (message) => logs.push(message),
      },
    );
    await mod.start();
    await waitFor(() => db.blocks.count() === 1);
    expect(
      logs.some((line) =>
        /^block failure attempt=\d+ peer=1\.1\.1\.1:8333 phase=session elapsedMs=\d+ cooldownMs=3000 error=connect exploded$/.test(
          line,
        ),
      ),
    ).toBe(true);

    await mod.stop();
    db.close();
  });

  test("honors idleDelayMs when a match appears without a kick", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const block = makeVariantBlock(0);
    const internalHex = internalHashHex(block);
    seedPeer(db, "1.1.1.1");

    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: makeOpenSession(new Map([[internalHex, block]])),
        concurrency: 1,
        idleDelayMs: 40,
      },
    );
    await mod.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(db.blocks.count()).toBe(0);

    db.matchedBlocks.insert({
      height: 0,
      blockHashInternalHex: internalHex,
    });
    // Poll is idleDelayMs (40), not PEER_WAIT_MS (1000). No bus kick.
    await waitFor(() => db.blocks.count() === 1, 800);

    await mod.stop();
    db.close();
  });

  test("while sync:idle, peers:updated does not open sessions", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const b0 = makeVariantBlock(0);
    const h0 = internalHashHex(b0);
    db.matchedBlocks.insert({ height: 0, blockHashInternalHex: h0 });
    seedPeer(db, "1.1.1.1");

    let opens = 0;
    const mod = createBlocksDownloadModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        openSession: async (host, port, opts) => {
          opens++;
          return makeOpenSession(new Map([[h0, b0]]))!(host, port, opts);
        },
        concurrency: 1,
      },
    );
    await mod.start();
    await waitFor(() => db.blocks.count() === 1);
    const opensAfter = opens;
    bus.emit("sync:idle", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    bus.emit("peers:updated", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    expect(opens).toBe(opensAfter);
    await mod.stop();
    db.close();
  });
});
