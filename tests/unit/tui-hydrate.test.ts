import { describe, expect, test } from "bun:test";
import { hexToBytes } from "bip158";
import { encodeBlockHeader } from "bitcoin-headers";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createBlocksMatchedStore } from "../../src/tui/blocks-matched-store.ts";
import { createFiltersProgressStore } from "../../src/tui/filters-progress-store.ts";
import { createHeadersProgressStore } from "../../src/tui/headers-progress-store.ts";
import {
  hydrateBlocks,
  hydrateFilters,
  hydrateFromDb,
  hydrateHeaders,
  hydrateMatching,
  hydratePeers,
  hydrateWallet,
} from "../../src/tui/hydrate.ts";
import { createMatchingProgressStore } from "../../src/tui/matching-progress-store.ts";
import { createPeerSocketsStore } from "../../src/tui/peer-sockets-store.ts";
import { createWalletTxsStore } from "../../src/tui/wallet-txs-store.ts";

function dummyHeader(): Uint8Array {
  return encodeBlockHeader({
    version: 1,
    previousBlockHash: new Uint8Array(32),
    merkleRoot: new Uint8Array(32),
    timestamp: 1,
    bits: 0x1d00ffff,
    nonce: 0,
  });
}

function addHeader(
  db: ReturnType<typeof createSqliteDatabase>,
  height: number,
  nibble: string,
): void {
  db.headers.append([
    {
      height,
      hashInternalHex: nibble.repeat(32),
      header: dummyHeader(),
      cumulativeWork: BigInt(height),
    },
  ]);
}

describe("tui hydrate", () => {
  test("hydrateFromDb fills durable stores from SQLite (not 0/0)", () => {
    const db = createSqliteDatabase(":memory:");
    addHeader(db, 10, "aa");
    addHeader(db, 11, "bb");
    db.filters.append([
      {
        height: 10,
        blockHashInternalHex: "aa".repeat(32),
        filter: hexToBytes("aa"),
      },
      {
        height: 11,
        blockHashInternalHex: "bb".repeat(32),
        filter: hexToBytes("bb"),
      },
    ]);
    db.filters.markScanned([10]);
    db.matchedBlocks.insert({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
    });
    db.matchedBlocks.insert({
      height: 11,
      blockHashInternalHex: "bb".repeat(32),
    });
    db.blocks.insert({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
      block: new Uint8Array([1]),
    });
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    db.transactions.upsert({
      txid: "ab".repeat(32),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "aa".repeat(32),
      tx: new Uint8Array([0x00]),
      netDeltaSats: 1500,
    });

    const stores = {
      peerSocketsStore: createPeerSocketsStore(),
      headersProgressStore: createHeadersProgressStore(),
      filtersProgressStore: createFiltersProgressStore(),
      matchingProgressStore: createMatchingProgressStore(),
      blocksMatchedStore: createBlocksMatchedStore(),
      walletTxsStore: createWalletTxsStore(),
    };
    hydrateFromDb(db, stores, undefined, 1000);

    expect(stores.peerSocketsStore.get().known).toBe(1);
    expect(stores.headersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 1,
      height: 11,
    });
    expect(stores.filtersProgressStore.get()).toMatchObject({
      downloaded: 2,
      total: 2,
    });
    expect(stores.matchingProgressStore.get()).toMatchObject({
      scanned: 1,
      total: 2,
    });
    expect(stores.blocksMatchedStore.get()).toMatchObject({
      downloaded: 1,
      matched: 2,
    });
    expect(stores.walletTxsStore.get().txs).toHaveLength(1);
    expect(stores.walletTxsStore.get().balanceSats).toBe(1500n);
    db.close();
  });

  test("empty DB hydrate leaves zeros", () => {
    const db = createSqliteDatabase(":memory:");
    const headersProgressStore = createHeadersProgressStore();
    hydrateHeaders(db, headersProgressStore, 500, 1);
    expect(headersProgressStore.get()).toMatchObject({
      downloaded: 0,
      total: 0,
      height: 0,
    });
    db.close();
  });

  test("headers total > 0 updates total; downloaded/height stay from DB", () => {
    const db = createSqliteDatabase(":memory:");
    addHeader(db, 10, "aa");
    addHeader(db, 11, "bb");
    const store = createHeadersProgressStore();
    hydrateHeaders(db, store, undefined, 1);
    expect(store.get()).toMatchObject({
      downloaded: 1,
      total: 1,
      height: 11,
    });
    hydrateHeaders(db, store, 0, 2);
    expect(store.get()).toMatchObject({
      downloaded: 1,
      total: 1,
      height: 11,
    });
    hydrateHeaders(db, store, 500, 3);
    expect(store.get()).toMatchObject({
      downloaded: 1,
      total: 500,
      height: 11,
    });
    hydrateHeaders(db, store, 0, 4);
    expect(store.get()).toMatchObject({
      downloaded: 1,
      total: 500,
      height: 11,
    });
    db.close();
  });

  test("filters rangeTotal > 0 updates total; downloaded stays from DB", () => {
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 1,
        blockHashInternalHex: "11".repeat(32),
        filter: hexToBytes("aa"),
      },
    ]);
    const store = createFiltersProgressStore();
    hydrateFilters(db, store, undefined, 1);
    expect(store.get()).toMatchObject({ downloaded: 1, total: 1 });
    hydrateFilters(db, store, 0, 2);
    expect(store.get()).toMatchObject({ downloaded: 1, total: 1 });
    hydrateFilters(db, store, 200, 3);
    expect(store.get()).toMatchObject({ downloaded: 1, total: 200, at: 3 });
    hydrateFilters(db, store, 0, 4);
    expect(store.get()).toMatchObject({ downloaded: 1, total: 200 });
    db.close();
  });

  test("filters downloaded is clamped to session total", () => {
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
    const store = createFiltersProgressStore();
    hydrateFilters(db, store, 1, 1);
    expect(store.get()).toMatchObject({ downloaded: 1, total: 1 });
    db.close();
  });

  test("matching and blocks follow DB, not caller counts", () => {
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
    db.matchedBlocks.insert({
      height: 1,
      blockHashInternalHex: "11".repeat(32),
    });
    const matching = createMatchingProgressStore();
    const blocks = createBlocksMatchedStore();
    hydrateMatching(db, matching, 1);
    hydrateBlocks(db, blocks, 1);
    expect(matching.get()).toMatchObject({ scanned: 1, total: 2 });
    expect(blocks.get()).toMatchObject({ downloaded: 0, matched: 1 });
    db.filters.markScanned([2]);
    db.blocks.insert({
      height: 1,
      blockHashInternalHex: "11".repeat(32),
      block: new Uint8Array([1]),
    });
    hydrateMatching(db, matching, 2);
    hydrateBlocks(db, blocks, 2);
    expect(matching.get()).toMatchObject({ scanned: 2, total: 2 });
    expect(blocks.get()).toMatchObject({ downloaded: 1, matched: 1 });
    db.close();
  });

  test("hydratePeers and hydrateWallet read SQLite", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "9.9.9.9",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    db.blocks.insert({
      height: 1,
      blockHashInternalHex: "11".repeat(32),
      block: new Uint8Array([1]),
    });
    db.transactions.upsert({
      txid: "cd".repeat(32),
      height: 1,
      txIndex: 0,
      blockHashInternalHex: "11".repeat(32),
      tx: new Uint8Array([0x00]),
      netDeltaSats: 42,
    });
    const peers = createPeerSocketsStore();
    const walletTxsStore = createWalletTxsStore();
    hydratePeers(db, peers);
    hydrateWallet(db, walletTxsStore, undefined, undefined, 9);
    expect(peers.get().known).toBe(1);
    expect(walletTxsStore.get().at).toBe(9);
    expect(walletTxsStore.get().balanceSats).toBe(42n);
    expect(walletTxsStore.get().blocksTotal).toBe(1);
    db.close();
  });
});
