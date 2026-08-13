# TUI hydrate / draw data path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TUI first paint read SQLite for durable tile data, treat most bus events as wakes, and apply payloads only for session facts (sockets, peer/filter `total > 0`, broadcast, status, sync idle).

**Architecture:** Add `src/tui/hydrate.ts` as the only draw-time SQLite reader. `tui-module` subscribes, calls `hydrateFromDb()` before React mounts, then hydrates a slice on each durable wake. Progress payload counts for matching/blocks/downloaded headers/filters are ignored. `total: 0` must not wipe a hydrated bar.

**Tech Stack:** Bun, TypeScript, existing `MessageBus` + SQLite `Database`, existing TUI stores. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-08-13-blueberry-tui-hydrate-draw-design.md`

## Global Constraints

- Follow the spec. Durable facts come from SQLite; session facts come from payloads.
- React tiles never open SQLite. Only `hydrate.ts` reads DB for draw.
- First paint: `tui.start()` hydrates, then `main.tsx` mounts React, then domain modules start. Do not change that order.
- Do not put tx lists on the bus. Do not persist peer tip. Do not add event names.
- `headers:progress.total` and `filters:progress.total` apply only when `> 0`. Otherwise keep the store `total` if it is already `> 0`, else use durable downloaded.
- `blocks:progress` must not call `hydrateWallet`.
- Skip Commit steps unless the user asks to commit.

## File structure

| File | Responsibility |
|------|----------------|
| `src/tui/hydrate.ts` | SQLite → stores (`hydrateFromDb` + per-slice helpers) |
| `src/tui/tui-module.ts` | Subscribe, hydrate, apply session payloads |
| `src/bus/types.ts` | Comments: durable wake vs session payload |
| `src/tui/blocks-matched-store.ts` | Remove `setMatched` |
| `src/main.tsx` | One comment: hydrate-before-domain is required for first paint |
| `tests/unit/tui-hydrate.test.ts` | Direct hydrate tests |
| `tests/unit/tui-*.test.ts` | Wiring: DB wins; zero payload does not clobber |
| `tests/unit/blocks-matched-store.test.ts` | Drop `setMatched` tests |

---

### Task 1: `hydrate.ts`

**Files:**
- Create: `src/tui/hydrate.ts`
- Test: `tests/unit/tui-hydrate.test.ts`

**Interfaces:**
- Consumes: `Database`, existing store types, `Wallet`, `snapshotFromDb`
- Produces:

```ts
import type { Database } from "../db/types.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { BlocksMatchedStore } from "./blocks-matched-store.ts";
import type { FiltersProgressStore } from "./filters-progress-store.ts";
import type { HeadersProgressStore } from "./headers-progress-store.ts";
import type { MatchingProgressStore } from "./matching-progress-store.ts";
import type { PeerSocketsStore } from "./peer-sockets-store.ts";
import type { ReceiveAddressStore } from "./receive-address-store.ts";
import type { WalletTxsStore } from "./wallet-txs-store.ts";

export type HydrateStores = {
  peerSocketsStore: PeerSocketsStore;
  headersProgressStore: HeadersProgressStore;
  filtersProgressStore: FiltersProgressStore;
  matchingProgressStore: MatchingProgressStore;
  blocksMatchedStore: BlocksMatchedStore;
  walletTxsStore: WalletTxsStore;
  receiveAddressStore?: ReceiveAddressStore;
};

export function hydratePeers(db: Database, store: PeerSocketsStore): void;
export function hydrateHeaders(
  db: Database,
  store: HeadersProgressStore,
  peerTotal?: number,
  at?: number,
): void;
export function hydrateFilters(
  db: Database,
  store: FiltersProgressStore,
  rangeTotal?: number,
  at?: number,
): void;
export function hydrateMatching(
  db: Database,
  store: MatchingProgressStore,
  at?: number,
): void;
export function hydrateBlocks(
  db: Database,
  store: BlocksMatchedStore,
  at?: number,
): void;
export function hydrateWallet(
  db: Database,
  walletTxsStore: WalletTxsStore,
  receiveAddressStore: ReceiveAddressStore | undefined,
  wallet: Wallet | undefined,
  at: number,
): void;
export function hydrateFromDb(
  db: Database,
  stores: HydrateStores,
  wallet?: Wallet,
  at?: number,
): void;
```

- [ ] **Step 1: Write the failing hydrate tests**

Create `tests/unit/tui-hydrate.test.ts`:

```ts
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
      downloaded: 2,
      total: 2,
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
      downloaded: 2,
      total: 2,
      height: 11,
    });
    hydrateHeaders(db, store, 0, 2);
    expect(store.get()).toMatchObject({
      downloaded: 2,
      total: 2,
      height: 11,
    });
    hydrateHeaders(db, store, 500, 3);
    expect(store.get()).toMatchObject({
      downloaded: 2,
      total: 500,
      height: 11,
    });
    hydrateHeaders(db, store, 0, 4);
    expect(store.get()).toMatchObject({
      downloaded: 2,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/tui-hydrate.test.ts`

Expected: FAIL — `hydrate.ts` does not exist.

- [ ] **Step 3: Implement `src/tui/hydrate.ts`**

```ts
import type { Database } from "../db/types.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { BlocksMatchedStore } from "./blocks-matched-store.ts";
import type { FiltersProgressStore } from "./filters-progress-store.ts";
import type { HeadersProgressStore } from "./headers-progress-store.ts";
import type { MatchingProgressStore } from "./matching-progress-store.ts";
import type { PeerSocketsStore } from "./peer-sockets-store.ts";
import type { ReceiveAddressStore } from "./receive-address-store.ts";
import type { WalletTxsStore } from "./wallet-txs-store.ts";
import { snapshotFromDb } from "./wallet-txs-store.ts";

export type HydrateStores = {
  peerSocketsStore: PeerSocketsStore;
  headersProgressStore: HeadersProgressStore;
  filtersProgressStore: FiltersProgressStore;
  matchingProgressStore: MatchingProgressStore;
  blocksMatchedStore: BlocksMatchedStore;
  walletTxsStore: WalletTxsStore;
  receiveAddressStore?: ReceiveAddressStore;
};

function sessionOrDurableTotal(
  incoming: number | undefined,
  previous: number,
  downloaded: number,
): number {
  if (incoming !== undefined && incoming > 0) return incoming;
  if (previous > 0) return previous;
  return downloaded;
}

export function hydratePeers(db: Database, store: PeerSocketsStore): void {
  store.setKnown(db.peers.count());
}

export function hydrateHeaders(
  db: Database,
  store: HeadersProgressStore,
  peerTotal?: number,
  at: number = Date.now(),
): void {
  const tip = db.headers.tip();
  const minH = db.headers.minHeight();
  if (!tip || minH === null) return;
  const downloaded = Math.max(0, tip.height - minH + 1);
  const total = sessionOrDurableTotal(
    peerTotal,
    store.get().total,
    downloaded,
  );
  store.applyEvent({
    at,
    downloaded,
    total,
    height: tip.height,
  });
}

export function hydrateFilters(
  db: Database,
  store: FiltersProgressStore,
  rangeTotal?: number,
  at: number = Date.now(),
): void {
  const downloaded = db.filters.count();
  const total = sessionOrDurableTotal(
    rangeTotal,
    store.get().total,
    downloaded,
  );
  store.applyEvent({ at, downloaded, total });
}

export function hydrateMatching(
  db: Database,
  store: MatchingProgressStore,
  at: number = Date.now(),
): void {
  const total = db.filters.count();
  store.applyEvent({
    at,
    scanned: db.filters.countScanned(),
    total,
  });
}

export function hydrateBlocks(
  db: Database,
  store: BlocksMatchedStore,
  at: number = Date.now(),
): void {
  store.applyEvent({
    at,
    downloaded: db.blocks.count(),
    matched: db.matchedBlocks.count(),
  });
}

export function hydrateWallet(
  db: Database,
  walletTxsStore: WalletTxsStore,
  receiveAddressStore: ReceiveAddressStore | undefined,
  wallet: Wallet | undefined,
  at: number,
): void {
  walletTxsStore.apply(snapshotFromDb(db, at, Date.now(), wallet));
  if (receiveAddressStore && wallet) {
    receiveAddressStore.refresh(db, wallet);
  }
}

export function hydrateFromDb(
  db: Database,
  stores: HydrateStores,
  wallet?: Wallet,
  at: number = Date.now(),
): void {
  hydratePeers(db, stores.peerSocketsStore);
  hydrateHeaders(db, stores.headersProgressStore, undefined, at);
  hydrateFilters(db, stores.filtersProgressStore, undefined, at);
  hydrateMatching(db, stores.matchingProgressStore, at);
  hydrateBlocks(db, stores.blocksMatchedStore, at);
  hydrateWallet(
    db,
    stores.walletTxsStore,
    stores.receiveAddressStore,
    wallet,
    at,
  );
}
```

- [ ] **Step 4: Run hydrate tests**

Run: `bun test tests/unit/tui-hydrate.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add src/tui/hydrate.ts tests/unit/tui-hydrate.test.ts
git commit -m "feat: hydrate TUI stores from SQLite."
```

---

### Task 2: Wire `tui-module` and fix wiring tests

**Files:**
- Modify: `src/tui/tui-module.ts` (replace inline DB seed and payload `applyEvent` for durable counts)
- Modify: `src/bus/types.ts` (comments only)
- Modify: `src/main.tsx` (one boot-order comment near TUI-first start)
- Modify: `tests/unit/tui-headers-progress.test.ts`
- Modify: `tests/unit/tui-filters-progress.test.ts`
- Modify: `tests/unit/tui-matching-progress.test.ts`
- Modify: `tests/unit/tui-blocks-matched.test.ts`
- Modify: `tests/unit/tui-wallet-txs.test.ts` (drop `blocks:progress` → wallet `blocksTotal`)

**Interfaces:**
- Consumes: Task 1 hydrate functions
- Produces: `createTuiModule` still has the same argument list. Start order: register handlers → `hydrateFromDb` → emit tui status.

- [ ] **Step 1: Rewrite wiring tests so DB wins**

In `tests/unit/tui-headers-progress.test.ts`, replace `"applies headers:progress events to the store"` with:

```ts
  test("hydrates headers from DB; payload total > 0 only; zeros do not clobber", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.headers.append([
      {
        height: 10,
        hashInternalHex: "aa".repeat(32),
        header: encodeBlockHeader({
          version: 1,
          previousBlockHash: new Uint8Array(32),
          merkleRoot: new Uint8Array(32),
          timestamp: 1,
          bits: 0x1d00ffff,
          nonce: 0,
        }),
        cumulativeWork: 10n,
      },
      {
        height: 11,
        hashInternalHex: "bb".repeat(32),
        header: encodeBlockHeader({
          version: 1,
          previousBlockHash: new Uint8Array(32),
          merkleRoot: new Uint8Array(32),
          timestamp: 2,
          bits: 0x1d00ffff,
          nonce: 0,
        }),
        cumulativeWork: 11n,
      },
    ]);
    const headersProgressStore = createHeadersProgressStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerSocketsStore(),
      headersProgressStore,
      createFiltersProgressStore(),
      createMatchingProgressStore(),
      createBlocksMatchedStore(),
      createWalletTxsStore(),
    );
    tui.start();
    expect(headersProgressStore.get()).toMatchObject({
      downloaded: 2,
      total: 2,
      height: 11,
    });
    bus.emit("headers:progress", {
      at: 1000,
      downloaded: 0,
      total: 0,
      height: 0,
    });
    expect(headersProgressStore.get()).toMatchObject({
      downloaded: 2,
      total: 2,
      height: 11,
    });
    bus.emit("headers:progress", {
      at: 2000,
      downloaded: 999,
      total: 500,
      height: 1,
    });
    expect(headersProgressStore.get()).toMatchObject({
      downloaded: 2,
      total: 500,
      height: 11,
      at: 2000,
    });
    tui.stop();
    db.close();
  });
```

Add `encodeBlockHeader` to that file’s imports from `"bitcoin-headers"`. Keep the existing `"chain-headers start does not clobber DB-seeded progress with 0/0"` test.

In `tests/unit/tui-filters-progress.test.ts`, add `import { hexToBytes } from "bip158";` and replace `"applies filters:progress events to the store"` with:

```ts
  test("hydrates filters from DB; payload total > 0 only; zeros do not clobber", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 1,
        blockHashInternalHex: "11".repeat(32),
        filter: hexToBytes("aa"),
      },
    ]);
    const filtersProgressStore = createFiltersProgressStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerSocketsStore(),
      createHeadersProgressStore(),
      filtersProgressStore,
      createMatchingProgressStore(),
      createBlocksMatchedStore(),
      createWalletTxsStore(),
    );
    tui.start();
    expect(filtersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 1,
    });
    bus.emit("filters:progress", {
      at: 500,
      downloaded: 0,
      total: 0,
    });
    expect(filtersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 1,
    });
    bus.emit("filters:progress", {
      at: 1000,
      downloaded: 50,
      total: 200,
    });
    expect(filtersProgressStore.get()).toMatchObject({
      downloaded: 1,
      total: 200,
      at: 1000,
      percent: 0,
    });
    tui.stop();
    db.close();
  });
```

Note: `percent` is `floor(100 * 1 / 200) = 0`. That is expected.

In `tests/unit/tui-matching-progress.test.ts`, change `"seeds from DB on tui start and applies matching:progress"` so the lying emit does **not** change the store, then `db.filters.markScanned([2])` and emit again:

```ts
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
```

In `tests/unit/tui-blocks-matched.test.ts`, replace the payload-wins test:

```ts
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
```

In `tests/unit/tui-wallet-txs.test.ts`, in `"seeds and refreshes txs..."`, replace the `blocks:progress` block with:

```ts
    const txsBefore = store.get().txs;
    db.blocks.insert({
      height: 3,
      blockHashInternalHex: "33".repeat(32),
      block: new Uint8Array([0xcc]),
    });
    bus.emit("blocks:progress", { at: 11, downloaded: 3, matched: 3 });
    expect(store.get().blocksTotal).toBe(2);
    expect(store.get().txs).toBe(txsBefore);

    bus.emit("wallet:txs", { at: 12 });
    expect(store.get().at).toBe(12);
    expect(store.get().blocksTotal).toBe(3);
    expect(store.get().blocksParsed).toBe(1);
```

- [ ] **Step 2: Run wiring tests to verify they fail**

Run:

```bash
bun test tests/unit/tui-headers-progress.test.ts tests/unit/tui-filters-progress.test.ts tests/unit/tui-matching-progress.test.ts tests/unit/tui-blocks-matched.test.ts tests/unit/tui-wallet-txs.test.ts
```

Expected: FAIL — TUI still applies payload counts and still refreshes wallet on `blocks:progress`.

- [ ] **Step 3: Replace `src/tui/tui-module.ts`**

```ts
import type { Module, ModuleContext } from "../modules/types.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { BlocksMatchedStore } from "./blocks-matched-store.ts";
import type { BroadcastStore } from "./broadcast-store.ts";
import type { FiltersProgressStore } from "./filters-progress-store.ts";
import type { HeadersProgressStore } from "./headers-progress-store.ts";
import {
  hydrateBlocks,
  hydrateFilters,
  hydrateFromDb,
  hydrateHeaders,
  hydrateMatching,
  hydratePeers,
  hydrateWallet,
} from "./hydrate.ts";
import type { MatchingProgressStore } from "./matching-progress-store.ts";
import type { PeerSocketsStore } from "./peer-sockets-store.ts";
import type { ReceiveAddressStore } from "./receive-address-store.ts";
import type { ModuleStatusStore } from "./status-store.ts";
import type { WalletTxsStore } from "./wallet-txs-store.ts";

export function createTuiModule(
  ctx: ModuleContext,
  store: ModuleStatusStore,
  peerSocketsStore: PeerSocketsStore,
  headersProgressStore: HeadersProgressStore,
  filtersProgressStore: FiltersProgressStore,
  matchingProgressStore: MatchingProgressStore,
  blocksMatchedStore: BlocksMatchedStore,
  walletTxsStore: WalletTxsStore,
  receiveAddressStore?: ReceiveAddressStore,
  wallet?: Wallet,
  broadcastStore?: BroadcastStore,
): Module {
  const unsubs: Array<() => void> = [];

  return {
    name: "tui",
    start() {
      unsubs.push(
        ctx.bus.on("module:status", (payload) => {
          store.set(payload.module, {
            status: payload.status,
            detail: payload.detail,
          });
        }),
      );
      unsubs.push(
        ctx.bus.on("peers:updated", () => {
          hydratePeers(ctx.db, peerSocketsStore);
        }),
      );
      unsubs.push(
        ctx.bus.on("peers:sockets", (p) => {
          peerSocketsStore.applyEvent(p);
        }),
      );
      unsubs.push(
        ctx.bus.on("headers:progress", (p) => {
          hydrateHeaders(ctx.db, headersProgressStore, p.total, p.at);
        }),
      );
      unsubs.push(
        ctx.bus.on("filters:progress", (p) => {
          hydrateFilters(ctx.db, filtersProgressStore, p.total, p.at);
        }),
      );
      unsubs.push(
        ctx.bus.on("matching:progress", (p) => {
          hydrateMatching(ctx.db, matchingProgressStore, p.at);
        }),
      );
      unsubs.push(
        ctx.bus.on("blocks:progress", (p) => {
          hydrateBlocks(ctx.db, blocksMatchedStore, p.at);
        }),
      );
      unsubs.push(
        ctx.bus.on("filters:match", () => {
          hydrateBlocks(ctx.db, blocksMatchedStore);
        }),
      );
      unsubs.push(
        ctx.bus.on("wallet:txs", (p) => {
          hydrateWallet(
            ctx.db,
            walletTxsStore,
            receiveAddressStore,
            wallet,
            p.at,
          );
        }),
      );
      unsubs.push(
        ctx.bus.on("sync:idle", () => {
          walletTxsStore.setParsingActive(true);
        }),
      );
      unsubs.push(
        ctx.bus.on("sync:catchup", () => {
          walletTxsStore.setParsingActive(false);
        }),
      );
      if (broadcastStore) {
        unsubs.push(
          ctx.bus.on("broadcast:progress", (p) => {
            broadcastStore.applyProgress(p);
          }),
        );
        unsubs.push(
          ctx.bus.on("broadcast:done", (p) => {
            broadcastStore.applyDone(p);
          }),
        );
      }
      hydrateFromDb(
        ctx.db,
        {
          peerSocketsStore,
          headersProgressStore,
          filtersProgressStore,
          matchingProgressStore,
          blocksMatchedStore,
          walletTxsStore,
          receiveAddressStore,
        },
        wallet,
      );
      ctx.bus.emit("module:status", { module: "tui", status: "starting" });
      ctx.bus.emit("module:status", { module: "tui", status: "running" });
    },
    stop() {
      for (const off of unsubs) off();
      unsubs.length = 0;
      ctx.bus.emit("module:status", { module: "tui", status: "stopped" });
    },
  };
}
```

- [ ] **Step 4: Update bus comments in `src/bus/types.ts`**

Replace the file header and the durable/session event comments (keep payload shapes unchanged):

```ts
/**
 * Typed in-process event catalog.
 *
 * Durable facts live in SQLite. The TUI hydrates those into stores at start
 * and on wake. Session facts (open sockets, peer/filter range total, broadcast,
 * module status, sync idle) live in payloads; the TUI applies those fields.
 *
 * `at` fields are Unix milliseconds (`Date.now()`).
 */
```

- `"peers:updated"`: `TUI wake: recount known peers from SQLite.`
- `"peers:sockets"`: keep; add `TUI applies kind/open. Not in SQLite.`
- `"headers:progress"`: `TUI wake: height/downloaded from SQLite. Apply total only if total > 0.`
- `"filters:progress"`: `TUI wake: downloaded from SQLite. Apply total only if total > 0.`
- `"filters:match"`: `TUI wake: refresh blocks downloaded/matched from SQLite.`
- `"matching:progress"`: `TUI wake: scanned/total from SQLite. Ignore payload counts.`
- `"blocks:progress"`: `TUI wake: downloaded/matched from SQLite. Ignore payload counts. Do not refresh wallet txs.`
- `"wallet:txs"`: `TUI wake: rebuild wallet snapshot from SQLite.`

Leave `module:status`, `sync:*`, `broadcast:*` as session payloads.

- [ ] **Step 5: Comment boot order in `src/main.tsx`**

Above `await startModule(tui!);` replace the existing TUI-first comment with:

```ts
  // TUI hydrates from SQLite in start(), then React mounts. Domain modules
  // start after. First paint must not wait on domain events (avoids 0/0).
```

- [ ] **Step 6: Run wiring tests**

Run:

```bash
bun test tests/unit/tui-hydrate.test.ts tests/unit/tui-headers-progress.test.ts tests/unit/tui-filters-progress.test.ts tests/unit/tui-matching-progress.test.ts tests/unit/tui-blocks-matched.test.ts tests/unit/tui-wallet-txs.test.ts tests/unit/tui-peer-sockets.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit (only if the user asked)**

```bash
git add src/tui/tui-module.ts src/bus/types.ts src/main.tsx tests/unit/tui-headers-progress.test.ts tests/unit/tui-filters-progress.test.ts tests/unit/tui-matching-progress.test.ts tests/unit/tui-blocks-matched.test.ts tests/unit/tui-wallet-txs.test.ts
git commit -m "fix: TUI draws durable counts from SQLite wakes."
```

---

### Task 3: Remove `setMatched`

**Files:**
- Modify: `src/tui/blocks-matched-store.ts`
- Modify: `tests/unit/blocks-matched-store.test.ts`

**Interfaces:**
- Consumes: Task 2 already routes `filters:match` through `hydrateBlocks`
- Produces: `BlocksMatchedStore` without `setMatched`

- [ ] **Step 1: Delete the `setMatched` store test**

In `tests/unit/blocks-matched-store.test.ts`, remove the entire test `"setMatched updates total without adding download samples"`. Keep `"percent, eta, and ignore non-advancing samples"`.

- [ ] **Step 2: Run the store test file**

Run: `bun test tests/unit/blocks-matched-store.test.ts`

Expected: PASS (one test left). Typecheck of `tui-module` must not still call `setMatched`.

- [ ] **Step 3: Remove `setMatched` from the store**

In `src/tui/blocks-matched-store.ts`:

- Delete `setMatched` from the `BlocksMatchedStore` type.
- Delete the `setMatched` method on the returned object.

- [ ] **Step 4: Run store + TUI tests**

Run:

```bash
bun test tests/unit/blocks-matched-store.test.ts tests/unit/tui-blocks-matched.test.ts tests/unit/tui-hydrate.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit (only if the user asked)**

```bash
git add src/tui/blocks-matched-store.ts tests/unit/blocks-matched-store.test.ts
git commit -m "refactor: drop blocks store setMatched."
```

---

### Task 4: Full TUI unit sweep

**Files:**
- Test: all `tests/unit/tui-*.test.ts` plus hydrate and blocks-matched-store

**Interfaces:**
- Consumes: Tasks 1–3
- Produces: no new API

- [ ] **Step 1: Run the TUI unit suite**

Run:

```bash
bun test tests/unit/tui-hydrate.test.ts tests/unit/tui-headers-progress.test.ts tests/unit/tui-filters-progress.test.ts tests/unit/tui-matching-progress.test.ts tests/unit/tui-blocks-matched.test.ts tests/unit/tui-wallet-txs.test.ts tests/unit/tui-peer-sockets.test.ts tests/unit/blocks-matched-store.test.ts tests/unit/filters-progress-store.test.ts tests/unit/headers-progress-store.test.ts
```

Expected: PASS

- [ ] **Step 2: Commit (only if the user asked)**

No extra files. Skip if the suite already passed in Task 2.
