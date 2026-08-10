# blueberry Sync Idle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause active peer discovery when headers/filters/blocks are caught up; keep sticky tip-following; resume discovery when behind or tip peers die.

**Architecture:** Pure `evaluateSyncState` + `sync-idle` coordinator emit `sync:idle` / `sync:catchup`. `peers-discovery` pauses its probe loop; `chain-headers` keeps ~30s sticky polls but ignores `peers:updated` while idle; filters/blocks stop restarting work on peer churn while idle.

**Tech Stack:** Bun, TypeScript, existing MessageBus + Module + SQLite patterns. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-03-blueberry-sync-idle-design.md`.
- Bus-only inter-module communication — modules never import each other.
- Caught up = headers at tip **and** filters complete for header range **and** blocks complete (no needing-download / `downloaded < matched`).
- Catchup reasons: `"headers" | "filters" | "blocks" | "peers"`.
- Startup mode is catchup (discovery running) until first true idle evaluation.
- Emit each mode transition once (no spam on every progress tick).
- Out of scope: TUI idle badge, slowing parse/matching polls, hard-killing in-flight probes, changing header `pollIntervalMs`.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).

## File structure

| Path | Responsibility |
|------|----------------|
| `src/bus/types.ts` | Add `sync:idle`, `sync:catchup` |
| `src/sync/types.ts` | `SyncMode`, `CatchupReason`, snapshot types |
| `src/sync/evaluate.ts` | Pure `evaluateSyncState(snapshot)` |
| `src/modules/sync-idle.ts` | Coordinator module: listen, snapshot DB/progress, emit transitions |
| `src/modules/peers-discovery.ts` | Pause/resume probe loop on sync events |
| `src/modules/chain-headers.ts` | Ignore `peers:updated` kicks while idle |
| `src/modules/filters-download.ts` | Ignore `peers:updated` → `requestRun` while idle |
| `src/modules/blocks-download.ts` | Ignore `peers:updated` kick while idle |
| `src/main.tsx` | Start `sync-idle` with other domain modules |
| `tests/sync-evaluate.test.ts` | Pure evaluator cases |
| `tests/sync-idle.test.ts` | Coordinator transitions + hysteresis |
| `tests/peers-discovery.test.ts` | Idle pauses probes; catchup resumes |
| `tests/filters-download.test.ts` | Idle ignores peer churn |
| `tests/blocks-download.test.ts` | Idle ignores peer churn |
| `tests/chain-headers.test.ts` | Idle ignores `peers:updated` (still polls) |

---

### Task 1: Bus events + pure `evaluateSyncState`

**Files:**
- Modify: `src/bus/types.ts`
- Create: `src/sync/types.ts`
- Create: `src/sync/evaluate.ts`
- Create: `tests/sync-evaluate.test.ts`

**Interfaces:**
- Consumes: none
- Produces:

```ts
// src/sync/types.ts
export type SyncMode = "idle" | "catchup";
export type CatchupReason = "headers" | "filters" | "blocks" | "peers";

export type SyncSnapshot = {
  /** From last headers:progress (0/0 = unknown tip). */
  headersDownloaded: number;
  headersTotal: number;
  /** missingRanges(...).length for [headersMin, headersTip]. */
  filterMissingRangeCount: number;
  /** True when filter catch-up needs CF peers but pool is thin. */
  filterWorkNeedsPeers: boolean;
  blocksDownloaded: number;
  blocksMatched: number;
  needingDownloadCount: number;
  alivePeerCount: number;
  aliveCompactFilterCount: number;
  minAliveCompactFilters: number;
};

export type SyncEvaluation =
  | { mode: "idle" }
  | { mode: "catchup"; reason: CatchupReason };

// src/sync/evaluate.ts
export function evaluateSyncState(s: SyncSnapshot): SyncEvaluation;

// EventMap additions:
"sync:idle": { at: number };
"sync:catchup": { at: number; reason: CatchupReason };
```

**Evaluation order (first match wins):**
1. `alivePeerCount === 0` → `catchup` / `"peers"`
2. `headersTotal <= 0` OR `headersDownloaded < headersTotal` → `"headers"`
3. `filterMissingRangeCount > 0` AND `filterWorkNeedsPeers` → `"peers"`
4. `filterMissingRangeCount > 0` → `"filters"`
5. `needingDownloadCount > 0` OR `blocksDownloaded < blocksMatched` → `"blocks"`
6. else → `idle`

- [ ] **Step 1: Write the failing evaluator test**

Create `tests/sync-evaluate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { evaluateSyncState } from "../src/sync/evaluate.ts";
import type { SyncSnapshot } from "../src/sync/types.ts";

function base(over: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    headersDownloaded: 100,
    headersTotal: 100,
    filterMissingRangeCount: 0,
    filterWorkNeedsPeers: false,
    blocksDownloaded: 5,
    blocksMatched: 5,
    needingDownloadCount: 0,
    alivePeerCount: 3,
    aliveCompactFilterCount: 16,
    minAliveCompactFilters: 16,
    ...over,
  };
}

describe("evaluateSyncState", () => {
  test("caught up → idle", () => {
    expect(evaluateSyncState(base())).toEqual({ mode: "idle" });
  });

  test("unknown header tip → headers", () => {
    expect(evaluateSyncState(base({ headersTotal: 0 }))).toEqual({
      mode: "catchup",
      reason: "headers",
    });
  });

  test("headers behind → headers", () => {
    expect(
      evaluateSyncState(base({ headersDownloaded: 90, headersTotal: 100 })),
    ).toEqual({ mode: "catchup", reason: "headers" });
  });

  test("filter gaps → filters", () => {
    expect(
      evaluateSyncState(base({ filterMissingRangeCount: 2 })),
    ).toEqual({ mode: "catchup", reason: "filters" });
  });

  test("filter gaps + thin CF pool → peers", () => {
    expect(
      evaluateSyncState(
        base({
          filterMissingRangeCount: 2,
          filterWorkNeedsPeers: true,
          aliveCompactFilterCount: 2,
        }),
      ),
    ).toEqual({ mode: "catchup", reason: "peers" });
  });

  test("blocks pending → blocks", () => {
    expect(
      evaluateSyncState(
        base({ needingDownloadCount: 1, blocksDownloaded: 4, blocksMatched: 5 }),
      ),
    ).toEqual({ mode: "catchup", reason: "blocks" });
  });

  test("no alive peers → peers", () => {
    expect(evaluateSyncState(base({ alivePeerCount: 0 }))).toEqual({
      mode: "catchup",
      reason: "peers",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sync-evaluate.test.ts`

Expected: FAIL (module not found / `evaluateSyncState` undefined)

- [ ] **Step 3: Implement types, bus events, evaluator**

Add to `src/bus/types.ts` `EventMap`:

```ts
"sync:idle": { at: number };
"sync:catchup": {
  at: number;
  reason: "headers" | "filters" | "blocks" | "peers";
};
```

Create `src/sync/types.ts` and `src/sync/evaluate.ts` with the interfaces/order above.

```ts
// src/sync/evaluate.ts
import type { SyncEvaluation, SyncSnapshot } from "./types.ts";

export function evaluateSyncState(s: SyncSnapshot): SyncEvaluation {
  if (s.alivePeerCount === 0) {
    return { mode: "catchup", reason: "peers" };
  }
  if (s.headersTotal <= 0 || s.headersDownloaded < s.headersTotal) {
    return { mode: "catchup", reason: "headers" };
  }
  if (s.filterMissingRangeCount > 0 && s.filterWorkNeedsPeers) {
    return { mode: "catchup", reason: "peers" };
  }
  if (s.filterMissingRangeCount > 0) {
    return { mode: "catchup", reason: "filters" };
  }
  if (
    s.needingDownloadCount > 0 ||
    s.blocksDownloaded < s.blocksMatched
  ) {
    return { mode: "catchup", reason: "blocks" };
  }
  return { mode: "idle" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sync-evaluate.test.ts`

Expected: PASS

---

### Task 2: `sync-idle` coordinator module

**Files:**
- Create: `src/modules/sync-idle.ts`
- Create: `tests/sync-idle.test.ts`
- Modify: `src/main.tsx` (wire module — can wait until Task 2 tests pass; wire in Step 5)

**Interfaces:**
- Consumes: `evaluateSyncState`, `SyncSnapshot`, bus events, `Database`
- Produces: `createSyncIdleModule(ctx, options?) → Module` named `"sync-idle"`

```ts
export type SyncIdleOptions = {
  evalIntervalMs?: number; // default 5_000
  filterBatchSize?: number; // default config.filterBatchSize
  minAliveCompactFilters?: number; // default 16
  now?: () => number;
};

export function createSyncIdleModule(
  ctx: ModuleContext,
  options?: SyncIdleOptions,
): Module;
```

**Snapshot rules:**
- Track last `headers:progress` → `headersDownloaded` / `headersTotal` (init `0/0`).
- Track last `blocks:progress` → `blocksDownloaded` / `blocksMatched` (init from DB counts on start).
- `filterMissingRangeCount`: if `headers.minHeight()` or `headers.tip()` null → treat as `1` (not idle). Else `db.filters.missingRanges(min, tip, filterBatchSize).length`.
- `alivePeerCount`: `db.peers.listAlive().length` is expensive at 250k — use a cheap bound: `listAliveWithServices(0n, 1).length` is wrong. Prefer `listAliveWithServices(1n /* NODE_NETWORK */, 1).length` OR add nothing new: call `listAlive()` only on timer (5s) and on `peers:updated` — acceptable for coordinator cadence. For tests with tiny DBs, `listAlive().length` is fine.
- `aliveCompactFilterCount`: `listAliveWithServices(NODE_COMPACT_FILTERS, minAliveCompactFilters).length`
- `filterWorkNeedsPeers`: `filterMissingRangeCount > 0 && aliveCompactFilterCount < minAliveCompactFilters`

**Lifecycle:**
- `mode` starts as `"catchup"` (do **not** emit catchup on start — discovery already running).
- On eval → idle: emit `sync:idle` once, set mode idle, `module:status` detail `"idle"`.
- On eval → catchup while idle: emit `sync:catchup` with reason, set mode catchup, status detail `"catchup:<reason>"`.
- Re-evaluate on `headers:progress`, `filters:progress`, `blocks:progress`, `peers:updated`, and `setInterval(evalIntervalMs)` (unref timer).

- [ ] **Step 1: Write the failing coordinator test**

Create `tests/sync-idle.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { NODE_COMPACT_FILTERS } from "bip157";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createSyncIdleModule } from "../src/modules/sync-idle.ts";
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

import { checkpointSeedRecord } from "../src/checkpoint.ts";

function seedCaughtUpDb(db: ReturnType<typeof createSqliteDatabase>) {
  db.peers.upsert({
    host: "1.1.1.1",
    port: 8333,
    services: BigInt(NODE_COMPACT_FILTERS),
    alive: true,
    usedForBlocks: false,
    lastProbedAt: null,
  });
  const seed = checkpointSeedRecord();
  db.headers.ensureCheckpoint(seed);
  const tip = db.headers.tip()!;
  db.filterHeaders.append([
    {
      height: tip.height,
      headerHex: "11".repeat(32),
    },
  ]);
  db.filters.append([
    {
      height: tip.height,
      blockHashInternalHex: tip.hashInternalHex,
      filterHex: "00",
    },
  ]);
  return tip;
}

function emitCaughtUpProgress(bus: ReturnType<typeof createMessageBus>) {
  bus.emit("headers:progress", { at: Date.now(), downloaded: 1, total: 1 });
  bus.emit("blocks:progress", { at: Date.now(), downloaded: 0, matched: 0 });
  bus.emit("filters:progress", { at: Date.now(), downloaded: 1, total: 1 });
}

describe("sync-idle", () => {
  test("emits sync:idle once when progress + DB say caught up", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    await seedCaughtUpDb(db);

    const idles: number[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();
    emitCaughtUpProgress(bus);

    await waitFor(() => idles.length >= 1);
    const n = idles.length;
    bus.emit("peers:updated", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 30));
    expect(idles.length).toBe(n);

    await mod.stop();
    db.close();
  });

  test("transitions idle → catchup:blocks when matched blocks need download", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const tip = await seedCaughtUpDb(db);

    const idles: number[] = [];
    const catchups: string[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));
    bus.on("sync:catchup", (p) => catchups.push(p.reason));

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();
    emitCaughtUpProgress(bus);
    await waitFor(() => idles.length >= 1);

    db.matchedBlocks.insert({
      height: tip.height,
      blockHashInternalHex: tip.hashInternalHex,
    });
    bus.emit("blocks:progress", { at: Date.now(), downloaded: 0, matched: 1 });
    await waitFor(() => catchups.includes("blocks"));
    expect(catchups.at(-1)).toBe("blocks");

    await mod.stop();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sync-idle.test.ts`

Expected: FAIL (module not found)

- [ ] **Step 3: Implement `createSyncIdleModule`**

Create `src/modules/sync-idle.ts` following the Interfaces above. Keep `buildSnapshot()` private. Use `NODE_COMPACT_FILTERS` from `bip157` and `config.filterBatchSize`.

Important details:
- Avoid full `listAlive()` on a 250k-row table. For `alivePeerCount`, only zero vs non-zero matters:

```ts
const alivePeerCount =
  ctx.db.peers.listAliveWithServices(1n, 1).length > 0 ||
  ctx.db.peers.listAliveWithServices(BigInt(NODE_COMPACT_FILTERS), 1)
    .length > 0
    ? 1
    : 0;
```

- For `aliveCompactFilterCount`, use capped  
  `listAliveWithServices(BigInt(NODE_COMPACT_FILTERS), minAliveCompactFilters).length`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/sync-idle.test.ts tests/sync-evaluate.test.ts`

Expected: PASS

- [ ] **Step 5: Wire into `main.tsx`**

Import `createSyncIdleModule` and add it to `domainModules` (after peers/headers/filters/blocks is fine; order among domain modules is not critical because it only emits bus events):

```ts
createSyncIdleModule(ctx),
```

Place it near the other sync modules in the `modules` array (e.g. after `createBlocksDownloadModule`).

---

### Task 3: Pause `peers-discovery` on `sync:idle`

**Files:**
- Modify: `src/modules/peers-discovery.ts`
- Modify: `tests/peers-discovery.test.ts`

**Interfaces:**
- Consumes: `sync:idle`, `sync:catchup`
- Produces: paused probe loop (no new probes, no DNS reseed, no `peers:updated` while paused)

- [ ] **Step 1: Write the failing test**

Append to `tests/peers-discovery.test.ts`:

```ts
  test("sync:idle pauses probes; sync:catchup resumes", async () => {
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
    db.peers.upsert({
      host: "2.2.2.2",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let probes = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        resolveSeeds: async () => [],
        probe: async () => {
          probes++;
          return { ok: false, error: "no" };
        },
        concurrency: 1,
        idleDelayMs: 20,
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    await waitFor(() => probes >= 1);
    const atIdle = probes;
    bus.emit("sync:idle", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 80));
    expect(probes).toBe(atIdle);
    bus.emit("sync:catchup", { at: Date.now(), reason: "headers" });
    await waitFor(() => probes > atIdle);
    await mod.stop();
    db.close();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/peers-discovery.test.ts -t "sync:idle pauses"`

Expected: FAIL (`probes` keeps increasing after idle)

- [ ] **Step 3: Implement pause/resume**

In `createPeersDiscoveryModule`:

```ts
let paused = false;
let unsubIdle: (() => void) | undefined;
let unsubCatchup: (() => void) | undefined;

// in runLoop, top of while:
while (!stopped) {
  if (paused) {
    await waitForKick(60_000); // woken by catchup/stop via kick()
    continue;
  }
  // ... existing body
}

// in start(), after stopped = false:
unsubIdle = ctx.bus.on("sync:idle", () => {
  paused = true;
  kick();
});
unsubCatchup = ctx.bus.on("sync:catchup", () => {
  paused = false;
  kick();
});

// in stop():
unsubIdle?.();
unsubCatchup?.();
paused = false;
```

Do not call `maybeReseed` / spawn probes while `paused`. In-flight probes started before pause may finish and emit `peers:updated` once — acceptable per spec.

- [ ] **Step 4: Run peers-discovery tests**

Run: `bun test tests/peers-discovery.test.ts`

Expected: PASS

---

### Task 4: Quiet mode for headers / filters / blocks

**Files:**
- Modify: `src/modules/chain-headers.ts`
- Modify: `src/modules/filters-download.ts`
- Modify: `src/modules/blocks-download.ts`
- Modify: `tests/chain-headers.test.ts` (or add focused cases)
- Modify: `tests/filters-download.test.ts`
- Modify: `tests/blocks-download.test.ts`

**Interfaces:**
- Each module tracks `quiet = false`, set true on `sync:idle`, false on `sync:catchup`.
- While `quiet`:
  - `chain-headers`: `peers:updated` handler is a no-op (poll timer still runs).
  - `filters-download`: `peers:updated` must not call `requestRun("peers")` (may still `kick()`).
  - `blocks-download`: `peers:updated` must not `kick()`.

- [ ] **Step 1: Write failing tests**

**filters-download** — append:

```ts
  test("while sync:idle, peers:updated does not start a new download run", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const fixture = buildFilterFixture();
    db.headers.append(fixture.headers);
    seedPeer(db);

    const downloadRuns = { count: 0 };
    const mod = createFiltersDownloadModule(
      { bus, db },
      {
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
```

**blocks-download** — append (reuse helpers already in that file: `makeOpenSession`, `seedPeer`, `makeVariantBlock`, `internalHashHex`, `waitFor`):

```ts
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
        openSession: async (host, port, opts) => {
          opens++;
          return makeOpenSession(new Map([[h0, b0]]))(host, port, opts);
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
```

**chain-headers** — append using the same injected-`fetchBatch` / large `pollIntervalMs` style as existing tests in that file:

```ts
  test("while sync:idle, peers:updated does not trigger fetchBatch", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.headers.ensureCheckpoint(checkpointSeedRecord());
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
```

- [ ] **Step 2: Run the new tests — expect FAIL**

Run:

```bash
bun test tests/filters-download.test.ts -t "while sync:idle"
bun test tests/blocks-download.test.ts -t "while sync:idle"
bun test tests/chain-headers.test.ts -t "while sync:idle"
```

- [ ] **Step 3: Implement quiet flags**

`chain-headers.ts`:

```ts
let quiet = false;
// start:
ctx.bus.on("sync:idle", () => { quiet = true; });
ctx.bus.on("sync:catchup", () => { quiet = false; kick(); });
unsubPeers = ctx.bus.on("peers:updated", () => {
  if (quiet) return;
  kick();
});
```

`filters-download.ts`:

```ts
let quiet = false;
unsubPeers = ctx.bus.on("peers:updated", () => {
  kick();
  if (quiet) return;
  requestRun("peers");
});
// also subscribe sync:idle / sync:catchup to set quiet; on catchup call requestRun("peers")
```

`blocks-download.ts`:

```ts
let quiet = false;
unsubPeers = ctx.bus.on("peers:updated", () => {
  if (quiet) return;
  kick();
});
// sync:idle → quiet=true; sync:catchup → quiet=false; kick()
```

Unsubscribe the new handlers in `stop()`.

- [ ] **Step 4: Run related tests**

Run:

```bash
bun test tests/filters-download.test.ts tests/blocks-download.test.ts tests/chain-headers.test.ts tests/sync-idle.test.ts tests/peers-discovery.test.ts
```

Expected: PASS

---

### Task 5: End-to-end wiring check + typecheck

**Files:**
- Verify: `src/main.tsx` includes `createSyncIdleModule(ctx)`
- No new files required beyond prior tasks

- [ ] **Step 1: Confirm module order in `main.tsx`**

```ts
const modules: Module[] = [
  createTuiModule(...),
  createBlocksDownloadModule(ctx, { ... }),
  createSyncIdleModule(ctx),
  createPeersDiscoveryModule(ctx, { ... }),
  createChainHeadersModule(ctx, { ... }),
  createFiltersDownloadModule(ctx, { ... }),
  createParseBlocksModule(ctx),
  createFiltersMatchingModule(ctx),
];
```

`sync-idle` may start before or after discovery; both are fine because initial mode is catchup without emitting.

- [ ] **Step 2: Run full automated verification**

```bash
bun test tests/sync-evaluate.test.ts tests/sync-idle.test.ts tests/peers-discovery.test.ts tests/filters-download.test.ts tests/blocks-download.test.ts tests/chain-headers.test.ts
bun run typecheck
```

Expected: all PASS, `tsc --noEmit` clean

- [ ] **Step 3: Manual smoke (optional, when user can restart app)**

1. Quit running blueberry (`q`).
2. `bun src/main.tsx`
3. After tiles show synced: CPU should drop; `ss -tpn | grep bun` should show few/no SYN-SENT storms; peer `last_probed_at` should stop advancing every second.
4. Wait for next header (~up to ~30s+): discovery may briefly resume then idle again after filters/blocks catch tip.

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| `sync:idle` / `sync:catchup` bus events | 1 |
| Caught-up / behind evaluation rules | 1–2 |
| Coordinator ownership | 2 |
| Pause/resume peers-discovery | 3 |
| Headers sticky poll + ignore peers while idle | 4 |
| Filters/blocks ignore peer churn while idle | 4 |
| Startup catchup; single transition emits | 2 |
| Fallback eval timer | 2 |
| Tests for coordinator + modules | 1–4 |
| Wire main | 2 / 5 |
| Out of scope items omitted | — |
