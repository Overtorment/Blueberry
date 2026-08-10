# blueberry Chain Headers Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync and validate mainnet headers from alive peers (BIP-324 `getheaders`), persist them in SQLite from a trusted checkpoint, emit `headers:progress`, and show progress/ETA in the Chain tip sync TUI tile.

**Architecture:** Hardcoded checkpoint lives in `src/checkpoint.ts` (outside the module). `chain-headers` waits for alive peers via `peers:updated`, walks them sequentially with the shared peer timeout, downloads header batches through `net/header-sync.ts`, validates with `bitcoin-headers` (`validateHeaderChain` / `HeaderBranchBuilder`), persists via `db.headers`, and emits progress. TUI updates an external store on each event.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bip324` / `bip324/node`, `bitcoin-headers`, existing MessageBus + OpenTUI React tiles. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-01-blueberry-chain-headers-sync-design.md` except the checkpoint-height amendment below.
- **Checkpoint amendment:** Spec asked for height `550000`, but `bitcoin-headers` retarget checks require the difficulty period-start header in-chain. `550000 % 2016 !== 0` (next retarget at `550368` needs height `548352`). Use trusted checkpoint **`548352`** (`2016 * 272`), the nearest difficulty boundary at or below 550000. Comment this in `src/checkpoint.ts`.
- Mainnet only; sequential one-peer header sync on the JS event loop.
- Timeout: `config.peerProbeTimeoutMs` (same constant as peers-discovery).
- Dead peers: session-local skip only; never clear DB `alive`.
- Progress total: highest peer `startHeight` seen where `startHeight > checkpointHeight`.
- Emit `headers:progress` only after a successful validated persist of an applied batch.
- Modules never import each other; communicate via bus + injected `db`.
- Do not copy from other codebases. Reimplement helpers under `src/`.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).
- Keep other domain modules as status-only scaffolds except `chain-headers` and TUI wiring.

## File structure

| Path | Responsibility |
|------|----------------|
| `src/checkpoint.ts` | Hardcoded 548352 seed + `BLUEBERRY_HEADER_CONSENSUS` |
| `src/db/types.ts` | Add `HeaderRecord`, `HeadersRepository`, `Database.headers` |
| `src/db/schema.ts` | Add `headers` table DDL |
| `src/db/sqlite-database.ts` | Implement headers API |
| `src/bus/types.ts` | Add `headers:progress` |
| `src/net/header-sync.ts` | BIP-324 handshake + `getheaders` batch |
| `src/modules/chain-headers.ts` | Sync loop (replace scaffold) |
| `src/tui/headers-progress-store.ts` | Progress + sample history + ETA |
| `src/tui/use-headers-progress.ts` | React hook |
| `src/tui/tui-module.ts` | Subscribe to `headers:progress` |
| `src/tui/components/ChainTipSync.tsx` | Bar, time, ETA |
| `src/main.tsx` | Pass timeout + progress store into modules |
| `tests/checkpoint.test.ts` | Hash / PoW / consensus seed checks |
| `tests/sqlite-headers.test.ts` | Headers repo |
| `tests/header-sync.test.ts` | Net helper with fakes |
| `tests/chain-headers.test.ts` | Sync loop with fakes |
| `tests/headers-progress-store.test.ts` | ETA / percent |
| `tests/tui-headers-progress.test.ts` | Bus → store wiring |

---

### Task 1: Hardcoded checkpoint (difficulty-aligned 548352)

**Files:**
- Create: `src/checkpoint.ts`
- Test: `tests/checkpoint.test.ts`

**Interfaces:**
- Consumes: `bitcoin-headers` (`hexToBytes`, `decodeBlockHeader`, `headerHashDisplay`, `headerHashInternal`, `meetsTarget`, `MAINNET_POW_LIMIT`, types)
- Produces:
  - `CHECKPOINT_HEIGHT = 548_352`
  - `CHECKPOINT_DISPLAY_HASH`, `CHECKPOINT_HEADER_HEX`, `CHECKPOINT_HEADER`
  - `PRE_CHECKPOINT_TIMESTAMPS` (10 timestamps, heights 548342..548351)
  - `BLUEBERRY_HEADER_CONSENSUS: HeaderConsensusParams`
  - `checkpointSeedRecord(): HeaderRecord`

- [ ] **Step 1: Write failing checkpoint tests**

Create `tests/checkpoint.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  decodeBlockHeader,
  headerHashDisplay,
  headerHashInternal,
  meetsTarget,
  validateHeaderChain,
} from "bitcoin-headers";
import {
  CHECKPOINT_DISPLAY_HASH,
  CHECKPOINT_HEADER,
  CHECKPOINT_HEIGHT,
  BLUEBERRY_HEADER_CONSENSUS,
  checkpointSeedRecord,
} from "../src/checkpoint.ts";

describe("checkpoint", () => {
  test("is difficulty-aligned and matches baked header", () => {
    expect(CHECKPOINT_HEIGHT % 2016).toBe(0);
    expect(CHECKPOINT_HEIGHT).toBe(548_352);
    const header = decodeBlockHeader(CHECKPOINT_HEADER);
    expect(headerHashDisplay(header)).toBe(CHECKPOINT_DISPLAY_HASH);
    expect(meetsTarget(headerHashInternal(header), header.bits)).toBe(true);
  });

  test("seed record validates as a one-header chain", () => {
    const seed = checkpointSeedRecord();
    const chain = validateHeaderChain(
      [seed],
      BLUEBERRY_HEADER_CONSENSUS,
      seed.header.timestamp + 60,
    );
    expect(chain.tipHeight).toBe(CHECKPOINT_HEIGHT);
    expect(chain.tipHashDisplay).toBe(CHECKPOINT_DISPLAY_HASH);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/checkpoint.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/checkpoint.ts`**

```ts
import {
  bytesToHex,
  decodeBlockHeader,
  headerHashDisplay,
  headerHashInternal,
  hexToBytes,
  MAINNET_POW_LIMIT,
  meetsTarget,
  type HeaderConsensusParams,
  type HeaderRecord,
} from "bitcoin-headers";

/**
 * Trusted sync anchor. Spec originally asked for height 550000, but
 * bitcoin-headers retarget rules need the difficulty period-start header
 * in-chain. 548352 = 2016 * 272 is the nearest boundary at or below 550000.
 */
export const CHECKPOINT_HEIGHT = 548_352;
export const CHECKPOINT_DISPLAY_HASH =
  "00000000000000000013f4778796947335e3ab173b555259675be50cdfe875fa";
export const CHECKPOINT_HEADER_HEX =
  "000000207bdbf7b6570e3e4ef228de993f89559216b67eed5bc71a0000000000000000007dc8575c22f4b2e6e7a9a7210b17f816c4cd44c4dbf557b3c69a5f338ce63209f867db5b922d271704280b32";
export const CHECKPOINT_HEADER = hexToBytes(CHECKPOINT_HEADER_HEX);

/** Heights 548342..548351 ascending (MTP window). */
export const PRE_CHECKPOINT_TIMESTAMPS = Object.freeze([
  1_541_099_351,
  1_541_099_507,
  1_541_100_654,
  1_541_101_792,
  1_541_101_787,
  1_541_102_015,
  1_541_102_298,
  1_541_102_418,
  1_541_103_042,
  1_541_104_406,
]);

export const BLUEBERRY_HEADER_CONSENSUS: HeaderConsensusParams = Object.freeze({
  powLimit: MAINNET_POW_LIMIT,
  targetSpacingSeconds: 10 * 60,
  targetTimespanSeconds: 14 * 24 * 60 * 60,
  retargetInterval: 2_016,
  medianTimeSpan: 11,
  maxFutureSeconds: 2 * 60 * 60,
  checkpoint: Object.freeze({
    height: CHECKPOINT_HEIGHT,
    headerBytes: CHECKPOINT_HEADER.slice(),
    hashDisplay: CHECKPOINT_DISPLAY_HASH,
    previousTimestamps: PRE_CHECKPOINT_TIMESTAMPS,
  }),
});

export function checkpointSeedRecord(): HeaderRecord & {
  header: ReturnType<typeof decodeBlockHeader>;
  hashInternal: Uint8Array;
} {
  const header = decodeBlockHeader(CHECKPOINT_HEADER);
  const display = headerHashDisplay(header);
  if (display !== CHECKPOINT_DISPLAY_HASH) {
    throw new Error(
      `checkpoint header hash mismatch: got ${display}, expected ${CHECKPOINT_DISPLAY_HASH}`,
    );
  }
  if (!meetsTarget(headerHashInternal(header), header.bits)) {
    throw new Error("checkpoint header fails PoW check");
  }
  const hashInternal = headerHashInternal(header);
  return {
    height: CHECKPOINT_HEIGHT,
    hashDisplay: CHECKPOINT_DISPLAY_HASH,
    hashInternalHex: bytesToHex(hashInternal),
    headerHex: bytesToHex(CHECKPOINT_HEADER),
    header,
    hashInternal,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/checkpoint.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 2: Typed SQLite headers repository

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/sqlite-database.ts`
- Test: `tests/sqlite-headers.test.ts`

**Interfaces:**
- Consumes: existing `createSqliteDatabase` / migrate pattern
- Produces on `Database`:

```ts
type HeaderRecord = {
  height: number;
  hashDisplay: string;
  hashInternalHex: string;
  headerHex: string;
};

interface HeadersRepository {
  ensureCheckpoint(checkpoint: HeaderRecord): void;
  tip(): HeaderRecord | null;
  count(): number;
  loadAll(): HeaderRecord[];
  loadFrom(height: number): HeaderRecord[];
  append(headers: HeaderRecord[]): void;
  replaceAfter(commonAncestorHeight: number, headers: HeaderRecord[]): void;
}
```

- [ ] **Step 1: Write failing headers-repo tests**

Create `tests/sqlite-headers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { checkpointSeedRecord } from "../src/checkpoint.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";

function hdr(height: number, suffix: string) {
  return {
    height,
    hashDisplay: "d".repeat(64 - suffix.length) + suffix,
    hashInternalHex: "i".repeat(64 - suffix.length) + suffix,
    headerHex: "ab".repeat(40),
  };
}

describe("SqliteDatabase headers", () => {
  test("ensureCheckpoint seeds once and rejects mismatch", () => {
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(seed);
    expect(db.headers.count()).toBe(1);
    expect(db.headers.tip()?.height).toBe(seed.height);
    db.headers.ensureCheckpoint(seed); // idempotent
    expect(db.headers.count()).toBe(1);
    expect(() =>
      db.headers.ensureCheckpoint({ ...seed, hashDisplay: "00".repeat(32) }),
    ).toThrow(/checkpoint/i);
    db.close();
  });

  test("append and replaceAfter", () => {
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(seed);
    db.headers.append([
      hdr(seed.height + 1, "a1"),
      hdr(seed.height + 2, "a2"),
    ]);
    expect(db.headers.count()).toBe(3);
    expect(db.headers.tip()?.height).toBe(seed.height + 2);
    db.headers.replaceAfter(seed.height, [
      hdr(seed.height + 1, "b1"),
      hdr(seed.height + 2, "b2"),
      hdr(seed.height + 3, "b3"),
    ]);
    expect(db.headers.count()).toBe(4);
    expect(db.headers.tip()?.hashDisplay.endsWith("b3")).toBe(true);
    expect(db.headers.loadFrom(seed.height + 1).map((h) => h.height)).toEqual([
      seed.height + 1,
      seed.height + 2,
      seed.height + 3,
    ]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sqlite-headers.test.ts`  
Expected: FAIL (`db.headers` missing)

- [ ] **Step 3: Extend types + schema + sqlite implementation**

In `src/db/types.ts`, add `HeaderRecord`, `HeadersRepository`, and `headers: HeadersRepository` on `Database`.

In `src/db/schema.ts`, append to `migrate`:

```sql
CREATE TABLE IF NOT EXISTS headers (
  height INTEGER PRIMARY KEY,
  hash_display TEXT NOT NULL,
  hash_internal_hex TEXT NOT NULL,
  header_hex TEXT NOT NULL
);
```

In `src/db/sqlite-database.ts`, implement `headers`:

- `ensureCheckpoint`: if count=0 insert; else load min height row and throw if height/hash/headerHex differ from checkpoint
- `tip`: `ORDER BY height DESC LIMIT 1`
- `count`: `COUNT(*)`
- `loadAll`: `ORDER BY height ASC`
- `loadFrom(height)`: `WHERE height >= ? ORDER BY height ASC`
- `append`: insert each row (caller guarantees contiguity)
- `replaceAfter(ancestor, headers)`: run in a transaction — `DELETE FROM headers WHERE height > ?` then insert `headers`

Map row columns ↔ camelCase like peers.

- [ ] **Step 4: Run tests**

Run: `bun test tests/sqlite-headers.test.ts tests/sqlite-peers.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 3: Bus event `headers:progress`

**Files:**
- Modify: `src/bus/types.ts`
- Test: `tests/message-bus.test.ts` (add one case) or rely on later wiring tests

**Interfaces:**
- Produces:

```ts
"headers:progress": {
  at: number;
  downloaded: number;
  total: number;
};
```

- [ ] **Step 1: Add to `EventMap` in `src/bus/types.ts`**

```ts
"headers:progress": {
  at: number;
  downloaded: number;
  total: number;
};
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`  
Expected: PASS

- [ ] **Step 3: Commit** (skip unless user asks)

---

### Task 4: Net helper `fetchHeadersBatch`

**Files:**
- Create: `src/net/header-sync.ts`
- Test: `tests/header-sync.test.ts`

**Interfaces:**
- Consumes: `bip324` Protocol patterns from `peer-probe.ts` (reuse connect/timeout style; do not import peer-probe internals)
- Produces:

```ts
export type HeaderSyncDuplex = { close(): Promise<void> | void };

export type HeaderBatchResult =
  | {
      ok: true;
      startHeight: number;
      headers: import("bip324").BlockHeader[]; // or bitcoin-headers BlockHeader — same shape
    }
  | { ok: false; error: string };

export type HeaderSyncOptions = {
  timeoutMs?: number;
  locatorHashes: Uint8Array[];
  stopHash?: Uint8Array;
  connect?: (
    host: string,
    port: number,
    signal?: AbortSignal,
  ) => Promise<HeaderSyncDuplex>;
  /** Injected for tests: given duplex, perform handshake+getheaders. */
  requestHeaders?: (
    duplex: HeaderSyncDuplex,
    port: number,
    locatorHashes: Uint8Array[],
    stopHash: Uint8Array,
  ) => Promise<{ startHeight: number; headers: BlockHeader[] }>;
};

export async function fetchHeadersBatch(
  host: string,
  port: number,
  options: HeaderSyncOptions,
): Promise<HeaderBatchResult>;
```

Default path: connect TCP → BIP-324 `Protocol.connect` → `version`/`verack` (capture `startHeight` from peer version) → `getheaders` → wait for `headers` (answer `ping`). Use the same timeout/abort/close pattern as `probePeer`.

- [ ] **Step 1: Write failing tests**

Create `tests/header-sync.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { fetchHeadersBatch } from "../src/net/header-sync.ts";

describe("fetchHeadersBatch", () => {
  test("maps connect failure to ok:false", async () => {
    const result = await fetchHeadersBatch("1.2.3.4", 8333, {
      timeoutMs: 500,
      locatorHashes: [new Uint8Array(32)],
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  test("returns headers from injected requestHeaders", async () => {
    const header = {
      version: 1,
      previousBlockHash: new Uint8Array(32),
      merkleRoot: new Uint8Array(32),
      timestamp: 1,
      bits: 0x1d00ffff,
      nonce: 0,
    };
    const result = await fetchHeadersBatch("1.2.3.4", 8333, {
      timeoutMs: 500,
      locatorHashes: [new Uint8Array(32)],
      connect: async () => ({ close() {} }),
      requestHeaders: async () => ({
        startHeight: 600_000,
        headers: [header],
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.startHeight).toBe(600_000);
      expect(result.headers).toHaveLength(1);
    }
  });

  test("timeout yields ok:false", async () => {
    const result = await fetchHeadersBatch("1.2.3.4", 8333, {
      timeoutMs: 20,
      locatorHashes: [new Uint8Array(32)],
      connect: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { close() {} };
      },
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/header-sync.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src/net/header-sync.ts`**

Mirror `peer-probe.ts` structure:

1. `AbortController` + `setTimeout(timeoutMs)` (default from caller; helper default `3000`)
2. `connectOrAbort` (copy the close-on-abort pattern from peer-probe)
3. Default `requestHeaders`:
   - `Protocol.connect(duplex, { role: "initiator", network: Networks.mainnet })`
   - send `version` (same fields as peer-probe; `startHeight: 0`, `relay: false`)
   - read until local verack complete; capture peer `version.payload.startHeight`
   - write `getheaders` with `{ version: 70016, locatorHashes, stopHash }` (`stopHash` default 32 zero bytes)
   - read until `headers` command; answer `ping` with `pong`
   - return `{ startHeight, headers: message.payload.headers }`
4. Always close duplex in `finally`

- [ ] **Step 4: Run tests**

Run: `bun test tests/header-sync.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 5: `chain-headers` sync module

**Files:**
- Replace: `src/modules/chain-headers.ts`
- Test: `tests/chain-headers.test.ts`

**Interfaces:**
- Consumes: `ModuleContext`, `CHECKPOINT_*` / `BLUEBERRY_HEADER_CONSENSUS` / `checkpointSeedRecord`, `db.headers`, `db.peers.listAlive`, bus `peers:updated` + `headers:progress`, `fetchHeadersBatch`
- Produces: `createChainHeadersModule(ctx, options?)`

```ts
export type ChainHeadersOptions = {
  fetchBatch?: typeof fetchHeadersBatch;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  /** seconds for consensus future-time checks */
  nowSeconds?: () => number;
};

export function createChainHeadersModule(
  ctx: ModuleContext,
  options?: ChainHeadersOptions,
): Module;
```

**Locator helper (in module file or small private fn):**

```ts
function buildLocator(hashesNewestFirst: Uint8Array[]): Uint8Array[] {
  // hashesNewestFirst[0] = tip hashInternal
  // include tip, then exponential backoff indices, cap 32
  const out: Uint8Array[] = [];
  let step = 1;
  let i = 0;
  while (i < hashesNewestFirst.length && out.length < 32) {
    out.push(hashesNewestFirst[i]!);
    i += step;
    if (out.length > 10) step *= 2;
  }
  return out;
}
```

Build `hashesNewestFirst` from `validateHeaderChain(db.headers.loadAll(), …).` tip walking via `entriesByHeight` / `hashInternal` from tip down (or from `loadAll` reversed `hashInternalHex`).

**Apply batch logic:**

```ts
import {
  HeaderBranchBuilder,
  HeaderConsensusError,
  bytesToHex,
  headerHashInternal,
  storedHeaderFromBlockHeader,
  validateHeaderChain,
} from "bitcoin-headers";

// After receiving bip324 headers[]:
const base = validateHeaderChain(
  ctx.db.headers.loadAll(),
  BLUEBERRY_HEADER_CONSENSUS,
  nowSeconds(),
);
const prevHex = bytesToHex(headers[0]!.previousBlockHash);
const ancestorHeight = base.heightByHashInternal.get(prevHex);
if (ancestorHeight === undefined) throw …;
const builder = new HeaderBranchBuilder(
  base,
  ancestorHeight,
  BLUEBERRY_HEADER_CONSENSUS,
  nowSeconds(),
);
const records = headers.map((h, i) =>
  storedHeaderFromBlockHeader(ancestorHeight + 1 + i, h),
);
// Only append headers that extend from ancestor; if peer sent headers
// already known, HeaderBranchBuilder will enforce linkage — if first
// header height should be ancestorHeight+1:
builder.append(records);
const branch = builder.finish();
if (branch.headers.length === 0) return; // nothing new
if (ancestorHeight === base.tipHeight) {
  ctx.db.headers.append([...branch.headers]);
} else if (branch.chainWork > base.chainWork) {
  ctx.db.headers.replaceAfter(ancestorHeight, [...branch.headers]);
} else {
  return; // ignore weaker branch
}
const tipHeight = ctx.db.headers.tip()!.height;
ctx.bus.emit("headers:progress", {
  at: now(),
  downloaded: tipHeight - CHECKPOINT_HEIGHT,
  total: Math.max(0, maxPeerStartHeight - CHECKPOINT_HEIGHT),
});
```

If `headers.length === 0`: treat as caught-up for this round (do not emit).

**Loop:**

1. `ensureCheckpoint(checkpointSeedRecord())` in `start`
2. `stopped` flag + wake on `peers:updated` / kick
3. `dead: Set<string>` session-local
4. While !stopped:
   - `alive = listAlive().filter(not in dead)`
   - if empty and `listAlive()` empty → wait on peers:updated / poll wake
   - if empty because all dead → `dead.clear()`, continue
   - pick next peer (round-robin index)
   - `fetchBatch(host, port, { timeoutMs: probeTimeoutMs, locatorHashes, requestHeaders? })`
   - on `!ok`: add to dead; continue
   - on ok: update `maxPeerStartHeight` if `startHeight > CHECKPOINT_HEIGHT`
   - if headers empty: if tip >= maxPeerStartHeight (or max still 0), `await sleep(pollIntervalMs)`; else rotate peer
   - if headers non-empty: apply; on consensus error → dead + continue; on success keep same peer for next batch
5. `stop`: set stopped, unsubscribe, kick waiters

Default `pollIntervalMs = 30_000`. Default `probeTimeoutMs = 3_000` (overridden from `config` in main).

- [ ] **Step 1: Write failing sync-loop tests**

Create `tests/chain-headers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decodeBlockHeader, hexToBytes } from "bitcoin-headers";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { CHECKPOINT_HEIGHT } from "../src/checkpoint.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createChainHeadersModule } from "../src/modules/chain-headers.ts";

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

describe("chain-headers", () => {
  test("waits for peers:updated then downloads and emits progress", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const events: Array<{ downloaded: number; total: number }> = [];
    bus.on("headers:progress", (p) => {
      events.push({ downloaded: p.downloaded, total: p.total });
    });

    // Minimal: fake fetch returns empty headers but sets startHeight so
    // progress can be tested with a real append in a second fake call.
    // Real mainnet header at 548353 (links from checkpoint 548352).
    const NEXT_HEADER_HEX =
      "00000020fa75e8df0ce55b675952553b17abe3357394968777f413000000000000000000e4039d625916c82c84715f4506f2f024827e5613849ead84ffa7c94cd9d541cd8b6bdb5b922d27176cb4104d";
    const nextHeader = decodeBlockHeader(hexToBytes(NEXT_HEADER_HEX));

    let calls = 0;
    const mod = createChainHeadersModule(
      { bus, db },
      {
        probeTimeoutMs: 200,
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
    // no alive peers yet
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
    await waitFor(() => events.length >= 1 && db.headers.tip()?.height === 548_353);
    expect(events[0]).toEqual({ downloaded: 1, total: 100 });
    await mod.stop();
    db.close();
  });

  test("rotates peers on failure and wraps the list", async () => {
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
    const mod = createChainHeadersModule(
      { bus, db },
      {
        probeTimeoutMs: 100,
        pollIntervalMs: 10_000,
        fetchBatch: async (host) => {
          tried.push(host);
          return { ok: false, error: "dead" };
        },
      },
    );
    await mod.start();
    await waitFor(() => tried.length >= 4);
    expect(tried.slice(0, 4)).toEqual([
      "1.1.1.1",
      "2.2.2.2",
      "1.1.1.1",
      "2.2.2.2",
    ]);
    await mod.stop();
    expect(db.peers.listAlive()).toHaveLength(2); // alive unchanged
    db.close();
  });
});
```

The first test above already appends real mainnet header `548353` via the baked hex fixture and asserts `headers:progress`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/chain-headers.test.ts`  
Expected: FAIL (still scaffold / missing API)

- [ ] **Step 3: Implement `createChainHeadersModule`**

Replace scaffold. Subscribe to `peers:updated` in `start` for wake. Implement loop as specified. Use `options.fetchBatch ?? fetchHeadersBatch`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/chain-headers.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 6: Headers progress store + ETA

**Files:**
- Create: `src/tui/headers-progress-store.ts`
- Create: `src/tui/use-headers-progress.ts`
- Test: `tests/headers-progress-store.test.ts`

**Interfaces:**

```ts
export type HeadersProgress = {
  downloaded: number;
  total: number;
  at: number | null;
  /** ms until complete; null if unknown */
  etaMs: number | null;
  percent: number; // 0..100
};

export type HeadersProgressStore = {
  get(): HeadersProgress;
  applyEvent(ev: { at: number; downloaded: number; total: number }): void;
  subscribe(listener: () => void): () => void;
};

export function createHeadersProgressStore(): HeadersProgressStore;
export function estimateEtaMs(
  samples: ReadonlyArray<{ at: number; downloaded: number }>,
  total: number,
): number | null;
```

ETA rules:

- Keep last up to 8 samples with strictly increasing `downloaded` (ignore non-advancing)
- Need ≥2 advancing samples
- `rate = (last.downloaded - first.downloaded) / (last.at - first.at)` headers/ms using oldest+newest in window (or last two — pick **first and last of advancing window**)
- if `rate <= 0` or `total <= downloaded` → `etaMs = 0` when done, else null
- `remaining = total - downloaded`; `etaMs = Math.round(remaining / rate)`

Percent: `total === 0 ? 0 : Math.min(100, Math.floor((100 * downloaded) / total))`

- [ ] **Step 1: Write failing store tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  createHeadersProgressStore,
  estimateEtaMs,
} from "../src/tui/headers-progress-store.ts";

describe("headers progress store", () => {
  test("percent and eta from advancing samples", () => {
    const store = createHeadersProgressStore();
    expect(store.get()).toMatchObject({
      downloaded: 0,
      total: 0,
      at: null,
      etaMs: null,
      percent: 0,
    });
    store.applyEvent({ at: 1000, downloaded: 100, total: 1000 });
    expect(store.get().percent).toBe(10);
    expect(store.get().etaMs).toBeNull();
    store.applyEvent({ at: 2000, downloaded: 200, total: 1000 });
    // 100 headers / 1000ms → 0.1 h/ms; remaining 800 → 8000ms
    expect(store.get().etaMs).toBe(8000);
    expect(store.get().at).toBe(2000);
  });

  test("estimateEtaMs null without advancement", () => {
    expect(estimateEtaMs([{ at: 1, downloaded: 5 }], 10)).toBeNull();
    expect(
      estimateEtaMs(
        [
          { at: 1, downloaded: 5 },
          { at: 2, downloaded: 5 },
        ],
        10,
      ),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/headers-progress-store.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement store + hook**

`use-headers-progress.ts` mirrors `use-peer-count.ts` with `setActiveHeadersProgressStore` + `useHeadersProgress()`.

- [ ] **Step 4: Run tests**

Run: `bun test tests/headers-progress-store.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 7: TUI wiring + Chain tip sync tile

**Files:**
- Modify: `src/tui/tui-module.ts`
- Modify: `src/tui/components/ChainTipSync.tsx`
- Modify: `src/main.tsx`
- Test: `tests/tui-headers-progress.test.ts`

**Interfaces:**
- `createTuiModule(ctx, statusStore, peerCountStore, headersProgressStore)`
- Chain tip sync shows: percent bar text, `downloaded/total`, last event time, ETA

- [ ] **Step 1: Write failing TUI wiring test**

```ts
import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createHeadersProgressStore } from "../src/tui/headers-progress-store.ts";
import { createPeerCountStore } from "../src/tui/peer-count-store.ts";
import { createModuleStatusStore } from "../src/tui/status-store.ts";
import { createTuiModule } from "../src/tui/tui-module.ts";

describe("TUI headers progress wiring", () => {
  test("applies headers:progress events to the store", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const headersProgressStore = createHeadersProgressStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerCountStore(),
      headersProgressStore,
    );
    tui.start();
    bus.emit("headers:progress", {
      at: 1000,
      downloaded: 50,
      total: 200,
    });
    expect(headersProgressStore.get()).toMatchObject({
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

- [ ] **Step 2: Run to verify fail**

Run: `bun test tests/tui-headers-progress.test.ts`  
Expected: FAIL (arity / missing store)

- [ ] **Step 3: Wire module + component + main**

`tui-module.ts`: accept `headersProgressStore`; `bus.on("headers:progress", (p) => headersProgressStore.applyEvent(p))`.

`ChainTipSync.tsx`:

```tsx
import { useHeadersProgress } from "../use-headers-progress.ts";
import { useModuleStatus } from "../use-module-status.ts";

function formatEta(etaMs: number | null): string {
  if (etaMs === null) return "—";
  if (etaMs <= 0) return "done";
  const s = Math.round(etaMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function formatTime(at: number | null): string {
  if (at === null) return "—";
  return new Date(at).toLocaleTimeString();
}

function bar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${percent}%`;
}

export function ChainTipSync() {
  const status = useModuleStatus("chain-headers");
  const p = useHeadersProgress();
  return (
    <box
      title="Chain tip sync"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    >
      <text>{status}</text>
      <text>{bar(p.percent)}</text>
      <text>
        {p.downloaded}/{p.total}
      </text>
      <text>last {formatTime(p.at)}</text>
      <text>ETA {formatEta(p.etaMs)}</text>
    </box>
  );
}
```

`main.tsx`:

```ts
const headersProgressStore = createHeadersProgressStore();
setActiveHeadersProgressStore(headersProgressStore);
// createTuiModule(..., headersProgressStore)
createChainHeadersModule(ctx, {
  probeTimeoutMs: config.peerProbeTimeoutMs,
}),
```

Update `tests/tui-peer-count.test.ts` to pass the new store argument (`createHeadersProgressStore()`).

- [ ] **Step 4: Run all tests + typecheck**

Run:

```bash
bun test
bun run typecheck
```

Expected: all PASS

- [ ] **Step 5: Commit** (skip unless user asks)

---

### Task 8: Manual smoke (optional)

- [ ] **Step 1:** `bun start` with an existing DB that has alive peers (or let peers-discovery fill some).
- [ ] **Step 2:** Confirm Chain tip sync shows rising percent, last event time, and ETA after a few batches.
- [ ] **Step 3:** Confirm `sqlite3 data/blueberry.sqlite 'select min(height), max(height), count(*) from headers;'` grows from 548352 upward.

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Checkpoint outside module | Task 1 (`src/checkpoint.ts`) |
| Height ~550000 hardened | Task 1 amendment → **548352** (difficulty-aligned) |
| Peers from DB, alive one | Task 5 |
| Wait on `peers:updated` | Task 5 |
| Download / validate / store | Tasks 2, 4, 5 |
| Same peer timeout | Tasks 5, 7 (`config.peerProbeTimeoutMs`) |
| Dead → next; wrap list | Task 5 |
| `headers:progress` downloaded+total | Tasks 3, 5 |
| total = max peer startHeight | Task 5 |
| Poll when at tip | Task 5 |
| Full reorg `replaceAfter` | Tasks 2, 5 |
| TUI bar + time + ETA | Tasks 6, 7 |
| No clear `alive` on failure | Task 5 tests |

**Amendment note for user:** Checkpoint is `548352` not `550000` so retarget validation works with `bitcoin-headers`.
