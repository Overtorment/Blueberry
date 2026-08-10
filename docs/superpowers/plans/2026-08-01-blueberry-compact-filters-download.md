# blueberry Compact Filters Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Download and verify BIP-157 basic compact filters for every stored block-header height, emit `filters:progress`, and show progress/ETA in the Filters download TUI tile.

**Architecture:** `filters-download` keys off the headers DB range (`minHeight`…`tip`), not a hardcoded checkpoint. It bootstraps mid-chain filter headers via `getcfcheckpt` + `getcfheaders` (`bip157` derive/verify), then downloads missing `cfilter`s concurrently (default 30 sessions, no race pool) from `NODE_COMPACT_FILTERS` peers. Storage stays behind `Database` repositories. TUI mirrors the headers progress-store pattern.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bip324` / `bip324/node`, `bip157`, existing MessageBus + OpenTUI React tiles. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-01-blueberry-compact-filters-download-design.md`.
- Height range = contiguous headers DB only (`headers.minHeight()` … `headers.tip()`). Never hardcode `548352` / `550000` in the filters module.
- Verification required before persist (`bip157` checkpoints + `verifyCFilterAgainstHeader`).
- Peers: `listAlive()` ∩ `NODE_COMPACT_FILTERS` (`1n << 6n` / `bip157.NODE_COMPACT_FILTERS`).
- Concurrency default 30; **no** race pool; own timeouts/batch sizes (not header sync knobs).
- Busy ignores `headers:progress`; idle + that event restarts remaining download. Start download on module init.
- Modules never import each other; communicate via bus + injected `db`.
- Do not copy from other codebases.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).
- Keep other domain modules as scaffolds except `filters-download` and TUI wiring touched here.

## File structure

| Path | Responsibility |
|------|----------------|
| `src/config.ts` | `filterSyncTimeoutMs`, `filterConcurrency`, batch sizes |
| `src/bus/types.ts` | `filters:progress` |
| `src/db/types.ts` | `headers.minHeight`, filter repos on `Database` |
| `src/db/schema.ts` | `filter_headers`, `filters` tables |
| `src/db/sqlite-database.ts` | Repository implementations |
| `src/net/peer-probe.ts` | Return peer `services` from version handshake |
| `src/modules/peers-discovery.ts` | Persist probed peer services |
| `src/net/filter-sync.ts` | BIP-324 + BIP-157 session helpers |
| `src/modules/filters-download.ts` | Busy/idle loop, phases, concurrency |
| `src/tui/filters-progress-store.ts` | Progress + ETA samples |
| `src/tui/use-filters-progress.ts` | React hook |
| `src/tui/tui-module.ts` | Subscribe `filters:progress` |
| `src/tui/components/FiltersDownload.tsx` | Bar / counts / ETA |
| `src/main.tsx` | Wire config + filters progress store |
| `tests/config.test.ts` | New defaults / env keys |
| `tests/sqlite-filters.test.ts` | Filter repos + `headers.minHeight` |
| `tests/peer-probe-services.test.ts` | Services captured from version |
| `tests/filter-sync.test.ts` | Net helper with fakes |
| `tests/filters-download.test.ts` | Module loop with fakes |
| `tests/filters-progress-store.test.ts` | ETA / percent |
| `tests/tui-filters-progress.test.ts` | Bus → store wiring |

---

### Task 1: Config + bus event

**Files:**
- Modify: `src/config.ts`
- Modify: `src/bus/types.ts`
- Modify: `tests/config.test.ts`

**Interfaces:**
- Consumes: existing `positiveIntEnv` / `loadConfig`
- Produces:
  - `AppConfig.filterSyncTimeoutMs` (default `120_000`, env `BLUEBERRY_FILTER_TIMEOUT_MS`)
  - `AppConfig.filterConcurrency` (default `30`, env `BLUEBERRY_FILTER_CONCURRENCY`)
  - `AppConfig.filterHeaderBatchSize` (default `2000`, env `BLUEBERRY_FILTER_HEADER_BATCH`)
  - `AppConfig.filterBatchSize` (default `1000`, env `BLUEBERRY_FILTER_BATCH`)
  - `EventMap["filters:progress"]`: `{ at: number; downloaded: number; total: number }`

- [ ] **Step 1: Update failing config expectations**

In `tests/config.test.ts`, extend defaults and override cases:

```ts
expect(loadConfig({})).toEqual({
  peerProbeTimeoutMs: 3_000,
  headerSyncTimeoutMs: 30_000,
  headerRacePeers: 10,
  peerConcurrency: 30,
  filterSyncTimeoutMs: 120_000,
  filterConcurrency: 30,
  filterHeaderBatchSize: 2000,
  filterBatchSize: 1000,
});

expect(
  loadConfig({
    BLUEBERRY_PEER_TIMEOUT_MS: "1500",
    BLUEBERRY_HEADER_TIMEOUT_MS: "12000",
    BLUEBERRY_HEADER_RACE_PEERS: "2",
    BLUEBERRY_PEER_CONCURRENCY: "8",
    BLUEBERRY_FILTER_TIMEOUT_MS: "60000",
    BLUEBERRY_FILTER_CONCURRENCY: "4",
    BLUEBERRY_FILTER_HEADER_BATCH: "500",
    BLUEBERRY_FILTER_BATCH: "250",
  }),
).toEqual({
  peerProbeTimeoutMs: 1500,
  headerSyncTimeoutMs: 12_000,
  headerRacePeers: 2,
  peerConcurrency: 8,
  filterSyncTimeoutMs: 60_000,
  filterConcurrency: 4,
  filterHeaderBatchSize: 500,
  filterBatchSize: 250,
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`  
Expected: FAIL (missing filter fields)

- [ ] **Step 3: Implement config + bus type**

`src/config.ts` — add the four fields via `positiveIntEnv`.

`src/bus/types.ts` — add:

```ts
"filters:progress": {
  at: number;
  downloaded: number;
  total: number;
};
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/config.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 2: Filter DB repositories + `headers.minHeight`

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/sqlite-database.ts`
- Create: `tests/sqlite-filters.test.ts`

**Interfaces:**
- Consumes: existing `createSqliteDatabase` / `migrate`
- Produces:

```ts
export type FilterHeaderRecord = {
  height: number;
  headerHex: string;
};

export type FilterRecord = {
  height: number;
  blockHashInternalHex: string;
  filterHex: string;
};

export interface FilterHeadersRepository {
  tip(): FilterHeaderRecord | null;
  get(height: number): FilterHeaderRecord | null;
  minHeight(): number | null;
  append(rows: FilterHeaderRecord[]): void;
  deleteFrom(height: number): void;
}

export interface FiltersRepository {
  count(): number;
  countInRange(from: number, to: number): number;
  has(height: number): boolean;
  get(height: number): FilterRecord | null;
  missingRanges(
    from: number,
    to: number,
    maxSpan: number,
  ): Array<{ from: number; to: number }>;
  append(rows: FilterRecord[]): void;
  deleteFrom(height: number): void;
}

// HeadersRepository +=
minHeight(): number | null;

// Database +=
filterHeaders: FilterHeadersRepository;
filters: FiltersRepository;
```

- [ ] **Step 1: Write failing tests**

Create `tests/sqlite-filters.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { checkpointSeedRecord } from "../src/checkpoint.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";

describe("SqliteDatabase filters", () => {
  test("headers.minHeight returns lowest stored height", () => {
    const db = createSqliteDatabase(":memory:");
    expect(db.headers.minHeight()).toBeNull();
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(seed);
    expect(db.headers.minHeight()).toBe(seed.height);
    db.close();
  });

  test("filter headers append/get/deleteFrom", () => {
    const db = createSqliteDatabase(":memory:");
    db.filterHeaders.append([
      { height: 10, headerHex: "aa".repeat(32) },
      { height: 11, headerHex: "bb".repeat(32) },
    ]);
    expect(db.filterHeaders.get(10)?.headerHex).toBe("aa".repeat(32));
    expect(db.filterHeaders.tip()?.height).toBe(11);
    db.filterHeaders.deleteFrom(11);
    expect(db.filterHeaders.tip()?.height).toBe(10);
    db.close();
  });

  test("filters missingRanges splits gaps by maxSpan", () => {
    const db = createSqliteDatabase(":memory:");
    db.filters.append([
      {
        height: 100,
        blockHashInternalHex: "11".repeat(32),
        filterHex: "01",
      },
      {
        height: 103,
        blockHashInternalHex: "33".repeat(32),
        filterHex: "03",
      },
    ]);
    expect(db.filters.missingRanges(100, 104, 2)).toEqual([
      { from: 101, to: 102 },
      { from: 104, to: 104 },
    ]);
    expect(db.filters.countInRange(100, 104)).toBe(2);
    db.filters.deleteFrom(103);
    expect(db.filters.has(103)).toBe(false);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sqlite-filters.test.ts`  
Expected: FAIL (missing methods / tables)

- [ ] **Step 3: Schema + types + SQLite impl**

`src/db/schema.ts` — inside `migrate`, after headers DDL:

```sql
CREATE TABLE IF NOT EXISTS filter_headers (
  height INTEGER PRIMARY KEY,
  header_hex TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS filters (
  height INTEGER PRIMARY KEY,
  block_hash_internal_hex TEXT NOT NULL,
  filter_hex TEXT NOT NULL
);
```

`headers.minHeight`:

```ts
minHeight() {
  const row = raw
    .query("SELECT MIN(height) AS h FROM headers")
    .get() as { h: number | null };
  return row.h ?? null;
}
```

`missingRanges` algorithm:

1. Load existing heights in `[from, to]` into a `Set`.
2. Scan `h` from `from` to `to`; collect contiguous missing runs.
3. Split each run into chunks of at most `maxSpan` (`{ from, to }` inclusive).

`append` for both filter tables: no-op on empty; use a single `BEGIN`/`COMMIT` transaction (same reason as headers).

Wire `filterHeaders` and `filters` on the returned `Database` object.

- [ ] **Step 4: Run tests**

Run: `bun test tests/sqlite-filters.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 3: Persist peer `services` from probe handshake

**Why:** Spec requires `NODE_COMPACT_FILTERS` peers. Today DNS seeds and probes leave `services = 0`, so the filter would never select anyone.

**Files:**
- Modify: `src/net/peer-probe.ts`
- Modify: `src/modules/peers-discovery.ts`
- Create: `tests/peer-probe-services.test.ts`
- Modify existing peer-discovery tests if signatures break

**Interfaces:**
- Consumes: bip324 `version` payload `services`
- Produces:

```ts
export type ProbeResult =
  | { ok: true; peers: PeerCandidate[]; services: bigint }
  | { ok: false; error: string };
```

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from "bun:test";
import { NODE_COMPACT_FILTERS } from "bip157";
import { probePeer } from "../src/net/peer-probe.ts";

describe("probePeer services", () => {
  test("returns services from injected handshake", async () => {
    const result = await probePeer("1.2.3.4", 8333, {
      timeoutMs: 500,
      connect: async () => ({ close() {} }),
      handshakeAndGetAddr: async () => ({
        peers: [],
        services: BigInt(NODE_COMPACT_FILTERS),
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.services).toBe(BigInt(NODE_COMPACT_FILTERS));
    }
  });
});
```

Adjust `handshakeAndGetAddr` type to return `{ peers: PeerCandidate[]; services: bigint }` (or keep returning peers only from the default path and wrap internally — prefer changing the injectable to return both so tests stay honest).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/peer-probe-services.test.ts`  
Expected: FAIL (type / missing services)

- [ ] **Step 3: Implement**

In `defaultHandshakeAndGetAddr` (or rename to return both): when `message.command === "version"`, capture `message.payload.services`. Return `{ peers, services }`.

In `peers-discovery` on `result.ok`:

```ts
ctx.db.peers.upsert({
  host: next.host,
  port: next.port,
  services: result.services,
  alive: true,
  usedForBlocks: false,
  lastProbedAt: now(),
});
// still upsert discovered addr peers; markAlive can remain
```

Ensure existing tests that mock `probe` return `services: 0n` (or a compact-filters bit when needed).

- [ ] **Step 4: Run tests**

Run: `bun test tests/peer-probe-services.test.ts tests/peers-discovery.test.ts tests/peer-probe.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 4: `net/filter-sync.ts` session helpers

**Files:**
- Create: `src/net/filter-sync.ts`
- Create: `tests/filter-sync.test.ts`

**Interfaces:**
- Consumes: `bip324` Protocol + `bip157` encode/decode (`encodeOutbound`, `decodeCFCheckpt`, `decodeCFHeaders`, `decodeCFilter`, `FILTER_TYPE_BASIC`, `BIP157_SHORT_IDS`)
- Produces:

```ts
export type FilterSyncDuplex = { close(): Promise<void> | void };

export type FilterBatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type FilterSyncOptions = {
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
  connect?: (
    host: string,
    port: number,
    signal?: AbortSignal,
  ) => Promise<FilterSyncDuplex>;
  /** Test seam: full post-connect behavior. */
  runSession?: (
    duplex: FilterSyncDuplex,
    port: number,
  ) => Promise<FilterSessionApi>;
};

export type FilterSessionApi = {
  services: bigint;
  getCFCheckpt(stopHash: Uint8Array): Promise<Uint8Array[]>;
  getCFHeaders(
    startHeight: number,
    stopHash: Uint8Array,
  ): Promise<{
    filterType: number;
    stopHash: Uint8Array;
    previousFilterHeader: Uint8Array;
    filterHashes: Uint8Array[];
  }>;
  getCFilters(
    startHeight: number,
    stopHash: Uint8Array,
    expectCount: number,
  ): Promise<Array<{ blockHash: Uint8Array; filterBytes: Uint8Array }>>;
  close(): Promise<void> | void;
};

export async function openFilterSession(
  host: string,
  port: number,
  options?: FilterSyncOptions,
): Promise<FilterBatchResult<FilterSessionApi>>;
```

Default session:

1. BIP-324 connect + `version`/`verack` (same shape as header-sync); capture `services` + ignore `startHeight` for totals.
2. Outbound BIP-157 via `encodeOutbound` → `protocol.writeMessage({ command: "opaque", type: { kind: "short", id }, payload })`.
3. Inbound: loop `readMessage`; answer `ping`; on `opaque` with matching short id, decode payload.
4. `getCFCheckpt`: send once; wait for `cfcheckpt`; return `filterHeaders`.
5. `getCFHeaders`: send once; wait for `cfheaders`.
6. `getCFilters`: send once; collect `expectCount` `cfilter` messages (order may vary — match by `blockHash` against expected hashes supplied by caller, **or** collect until count reached and let module verify/order by height). Prefer: return messages as received; module maps hash → height via headers DB.
7. Timeouts: connect budget `connectTimeoutMs`; per-request budget `syncTimeoutMs` after handshake.
8. Always close duplex on `session.close()` / open failure.

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { openFilterSession } from "../src/net/filter-sync.ts";

describe("openFilterSession", () => {
  test("maps connect failure to ok:false", async () => {
    const result = await openFilterSession("1.2.3.4", 8333, {
      connectTimeoutMs: 100,
      syncTimeoutMs: 100,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
  });

  test("uses injected runSession", async () => {
    const stop = new Uint8Array(32);
    const result = await openFilterSession("1.2.3.4", 8333, {
      connect: async () => ({ close() {} }),
      runSession: async () => ({
        services: 64n,
        async getCFCheckpt() {
          return [new Uint8Array(32)];
        },
        async getCFHeaders() {
          return {
            filterType: 0,
            stopHash: stop,
            previousFilterHeader: new Uint8Array(32),
            filterHashes: [new Uint8Array(32)],
          };
        },
        async getCFilters() {
          return [{ blockHash: stop, filterBytes: new Uint8Array([1]) }];
        },
        close() {},
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.services).toBe(64n);
      expect(await result.value.getCFCheckpt(stop)).toHaveLength(1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/filter-sync.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/net/filter-sync.ts`**

Mirror timeout/abort/close patterns from `src/net/header-sync.ts`. Keep production path real; tests use `runSession`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/filter-sync.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 5: `filters-download` module

**Files:**
- Replace: `src/modules/filters-download.ts`
- Create: `tests/filters-download.test.ts`

**Interfaces:**
- Consumes: `ModuleContext`, `db.headers` / `filterHeaders` / `filters` / `peers`, bus `headers:progress` + `peers:updated` + `filters:progress`, `openFilterSession`, `bip157` (`NODE_COMPACT_FILTERS`, `deriveFilterHeaders`, `verifyCFilterAgainstHeader`, `verifyFilterHeaderChain`, `CF_CHECKPT_INTERVAL`, `FILTER_TYPE_BASIC`, `bytesToHex`, `hexToBytes`)
- Produces:

```ts
export type FiltersDownloadOptions = {
  openSession?: typeof openFilterSession;
  connectTimeoutMs?: number;
  syncTimeoutMs?: number;
  concurrency?: number;
  headerBatchSize?: number;
  filterBatchSize?: number;
  idleDelayMs?: number;
  now?: () => number;
};

export function createFiltersDownloadModule(
  ctx: ModuleContext,
  options?: FiltersDownloadOptions,
): Module;
```

**State machine**

```ts
let stopped = true;
let busy = false;
let wake: (() => void) | undefined;
let runGeneration = 0;

function kick() { wake?.(); }

function requestRun(reason: "start" | "headers" | "peers") {
  if (stopped) return;
  if (busy) return; // ignore duplicate kicks while in progress
  void runDownload();
}
```

**`runDownload` outline**

1. `busy = true`.
2. Reconcile reorg:
   - `from = headers.minHeight()`, `to = headers.tip()?.height`; if either null → emit progress zeros if useful, `busy = false`, return.
   - If filter tip height `> to` → `filterHeaders.deleteFrom(to + 1)`, `filters.deleteFrom(to + 1)`.
   - From `min(filterTip, to)` downward while heights exist: if `filters.get(h)?.blockHashInternalHex !== headers.get(h)?.hashInternalHex` → `deleteFrom(h)` on both filter tables; break.
3. Emit `filters:progress` with `downloaded = filters.countInRange(from, to)`, `total = to - from + 1`.
4. **Phase 1 — filter headers (sequential, one session at a time):**
   - Pick compact-filter alive peer (skip session `dead` set).
   - `getCFCheckpt(tipHashInternal)`.
   - Store checkpoint map: height `(i+1)*CF_CHECKPT_INTERVAL` → header bytes (only need those `>= from` and `<= to`, but keep all for verify).
   - Let `next =` first height in `[from, to]` missing from `filterHeaders` (if gap in the middle, deleteFrom that gap start first so chain stays contiguous — or require contiguous append from `from`).
   - While `next <= to`: choose `stop = min(next + headerBatchSize - 1, to)`; `getCFHeaders(next, blockHashAt(stop))`; derive via `deriveFilterHeaders(previousFilterHeader, filterHashes)`; verify:
     - length = `stop - next + 1`
     - for any checkpoint height in range, derived header equals checkpoint
     - if `next === from` and `from % CF_CHECKPT_INTERVAL === 0`, derived[0] must equal checkpoint[from] (authenticates previous)
     - else if some checkpoint `C` with `next <= C <= stop`, derived header at `C` must match (authenticates chain including previous)
     - else if `next > from`, `previousFilterHeader` must equal `filterHeaders.get(next - 1)`
   - On verify fail: dead-peer, retry phase with another peer (do not persist).
   - On success: `filterHeaders.append` rows; `next = stop + 1`; emit progress (downloaded unchanged is ok; still fine to emit).
5. **Phase 2 — filters (concurrent):**
   - `queue = filters.missingRanges(from, to, filterBatchSize)`
   - Worker pool size `concurrency`:
     - take range; pick peer; open session; `getCFilters(start, stopHash, count)`
     - for each message: resolve height via `headers.heightForHashInternal(bytesToHex(blockHash))` (must fall in range); load `expected = filterHeaders.get(height)`, `prev = height === from ? previousBootstrap : filterHeaders.get(height - 1)` — for `height === from`, previous is the authenticated `previousFilterHeader` from the first cfheaders batch (persist it implicitly by having `filterHeaders` at `from` and storing genesis-prev only when `from === 0`; when `from > 0`, verify using `filterHeader` math: you need prev — **persist `previousFilterHeader` used at bootstrap as a synthetic row is wrong**. Instead: when verifying height `h`, `prev = filterHeaders.get(h - 1)`; for `h === from`, keep `bootstrapPrev` in module memory from the first accepted `getCFHeaders(from, …).previousFilterHeader` after checkpoint authentication, **or** persist an optional side table. Simplest durable approach: after accepting first batch starting at `from`, you already have `filterHeaders[from]`; verification needs prev — store `bootstrapPreviousFilterHeader` in a tiny single-row table or as `filter_headers` height `from - 1` **only if** `from > 0` and we don't have block header there. Prefer module-private DB row:
       - Add nullable support: allow `filter_headers` to store height `from - 1` as the authenticated previous header (no matching block header required). Document as “bootstrap prev”. Reorg `deleteFrom` uses header cut height and also deletes `from - 1` when cutting at `from`.
     - Spec amendment for implementers: **persist authenticated `previousFilterHeader` at height `from - 1` when `from > 0`**, even without a block header at that height. `deleteFrom(from)` must also remove `from - 1` bootstrap row when wiping the range start.
   - `verifyCFilterAgainstHeader({ filterBytes, previousFilterHeader, expectedFilterHeader })`; on failure throw → dead peer, requeue range.
   - Persist accepted filters via `filters.append`; emit `filters:progress`.
6. When queue empty and headers complete → `busy = false`. If still missing (peer starvation), wait/`kick` and leave busy false so a kick can retry — **or** stay in loop until caught up or stopped. Prefer: loop until `missingRanges` empty or `stopped`; if no peers, `await waitForKick(idleDelayMs)`.
7. Subscribe in `start`: `headers:progress` → `requestRun("headers")`; `peers:updated` → `kick()` (and `requestRun` only if `!busy` and work remains — actually peers:updated should wake waiters; if idle and work remains, `requestRun`).

**`start`**

```ts
async start() {
  if (!stopped) return;
  ctx.bus.emit("module:status", { module: "filters-download", status: "starting" });
  stopped = false;
  unsubHeaders = ctx.bus.on("headers:progress", () => requestRun("headers"));
  unsubPeers = ctx.bus.on("peers:updated", () => {
    kick();
    requestRun("peers");
  });
  requestRun("start");
  ctx.bus.emit("module:status", { module: "filters-download", status: "running" });
}
```

**`stop`:** `stopped = true`; unsubscribe; `kick()`; best-effort close open sessions.

- [ ] **Step 1: Write failing module tests**

Create `tests/filters-download.test.ts` covering:

1. **Ignores kick while busy** — start with slow injected `openSession`; emit `headers:progress` twice; assert only one download generation (use a counter in fake).
2. **Idle kick resumes** — fake first run fills filters for current tip; emit `headers:progress` after tip grows (append header + kick); assert more filters downloaded / second run happened.
3. **Emits progress** — after successful fake cfilters, bus received `filters:progress` with `downloaded` / `total`.
4. **Rejects bad filter** — verifier path: fake returns wrong bytes → nothing persisted for that height; peer rotated.

Use `:memory:` DB, seed checkpoint header + a few fake headers, seed an alive peer with `services: BigInt(NODE_COMPACT_FILTERS)`, inject `openSession` that serves scripted cfcheckpt/cfheaders/cfilters consistent with `bip158`/`bip157` helpers (build filter bytes + headers with `filterHash` / `filterHeader` from `bip158`).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/filters-download.test.ts`  
Expected: FAIL (scaffold has no behavior)

- [ ] **Step 3: Implement module**

Replace scaffold in `src/modules/filters-download.ts` with the loop above. Cap batch sizes with `Math.min(config, MAX_GETCF*)` from `bip157`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/filters-download.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 6: TUI progress store + tile + wiring

**Files:**
- Create: `src/tui/filters-progress-store.ts`
- Create: `src/tui/use-filters-progress.ts`
- Create: `tests/filters-progress-store.test.ts`
- Create: `tests/tui-filters-progress.test.ts`
- Modify: `src/tui/tui-module.ts`
- Modify: `src/tui/components/FiltersDownload.tsx`
- Modify: `src/main.tsx`
- Modify: `tests/tui-headers-progress.test.ts` (pass new `filtersProgressStore` arg)

**Interfaces:**
- Consumes: `filters:progress` events
- Produces: store/hook API identical in shape to headers progress (`downloaded`, `total`, `at`, `etaMs`, `percent`)

- [ ] **Step 1: Write failing store + wiring tests**

Copy `tests/headers-progress-store.test.ts` → `tests/filters-progress-store.test.ts` with renamed imports/symbols.

Wiring test (mirror headers):

```ts
import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createFiltersProgressStore } from "../src/tui/filters-progress-store.ts";
import { createHeadersProgressStore } from "../src/tui/headers-progress-store.ts";
import { createPeerCountStore } from "../src/tui/peer-count-store.ts";
import { createModuleStatusStore } from "../src/tui/status-store.ts";
import { createTuiModule } from "../src/tui/tui-module.ts";

describe("TUI filters progress wiring", () => {
  test("applies filters:progress events to the store", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const filtersProgressStore = createFiltersProgressStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerCountStore(),
      createHeadersProgressStore(),
      filtersProgressStore,
    );
    tui.start();
    bus.emit("filters:progress", {
      at: 1000,
      downloaded: 50,
      total: 200,
    });
    expect(filtersProgressStore.get()).toMatchObject({
      downloaded: 50,
      total: 200,
      at: 1000,
      percent: 25,
    });
    tui.stop();
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/filters-progress-store.test.ts tests/tui-filters-progress.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement store, hook, TUI, main**

- `filters-progress-store.ts` — same logic as headers store (can duplicate; do not over-abstract).
- `use-filters-progress.ts` — same pattern as `use-headers-progress.ts`.
- `createTuiModule(..., filtersProgressStore)` — subscribe `filters:progress`.
- `FiltersDownload.tsx` — mirror `ChainTipSync.tsx` (bar, `downloaded/total`, ETA).
- `main.tsx`:

```ts
const filtersProgressStore = createFiltersProgressStore();
setActiveFiltersProgressStore(filtersProgressStore);

createTuiModule(
  ctx,
  statusStore,
  peerCountStore,
  headersProgressStore,
  filtersProgressStore,
);

createFiltersDownloadModule(ctx, {
  connectTimeoutMs: config.peerProbeTimeoutMs,
  syncTimeoutMs: config.filterSyncTimeoutMs,
  concurrency: config.filterConcurrency,
  headerBatchSize: config.filterHeaderBatchSize,
  filterBatchSize: config.filterBatchSize,
});
```

- [ ] **Step 4: Run full relevant suite + typecheck**

Run:

```bash
bun test tests/config.test.ts tests/sqlite-filters.test.ts tests/peer-probe-services.test.ts tests/filter-sync.test.ts tests/filters-download.test.ts tests/filters-progress-store.test.ts tests/tui-filters-progress.test.ts
bun run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Range = headers min…tip, not hardcoded checkpoint | 2, 5 |
| `Database` repos for filter headers + filters | 2 |
| `headers.minHeight` | 2 |
| Verify via cfcheckpt/cfheaders/cfilter | 4, 5 |
| Mid-chain bootstrap without pre-range block hashes | 5 (+ bootstrap prev at `from-1`) |
| `NODE_COMPACT_FILTERS` peers only | 3, 5 |
| Own config constants; concurrency default 30; no race | 1, 5 |
| Start on init; busy ignores kick; idle resumes on `headers:progress` | 5 |
| `filters:progress` per successful batch | 5 |
| TUI bar + ETA after samples | 6 |
| Reorg reconcile deleteFrom | 5 |
| Persist probed services (enables peer filter) | 3 |

## Plan self-review notes

- Bootstrap previous filter header at `from - 1` is an implementer clarification required for verification when `from > 0`; it does not require block headers below `from`.
- Peer `services` persistence is required for the spec’s peer filter to work on a live node; included as Task 3.
- No `createFilterSync` from genesis — module composes wire/verify helpers as specified.
