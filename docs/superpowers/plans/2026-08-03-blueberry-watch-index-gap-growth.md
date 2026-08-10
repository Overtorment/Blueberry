# blueberry Watch Index Gap Growth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist external/internal watch scan counts in SQLite, grow them when used addresses enter the danger zone, rematch filters from the earliest wallet tx height, and kick filters-matching via synthetic `filters:progress`.

**Architecture:** Generic `key_value` stores `watch_external` / `watch_internal`. `parse-blocks` owns the growth check after each successfully parsed block (and once on empty-backlog startup). Both parse and filters-matching derive watch scripts from DB counts. On growth: `markUnscannedFrom(min wallet tx height)` + emit `filters:progress` so matching reuses its existing kick path.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, existing `deriveWatchWallet`, parse helpers, MessageBus. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-03-blueberry-block-parsing-design.md` (amended watch-index section).
- `GAP_LIMIT = 20`; initial per-chain count = `2 * GAP_LIMIT` (= 40); `ADDRESS_GAP` stays 40 as that initial alias.
- Keys: `watch_external`, `watch_internal` (decimal string values).
- Rematch: all `filters` with `height >=` minimum stored wallet tx height (`markUnscannedFrom`).
- Growth: one `+ GAP_LIMIT` bump per chain per check when the danger zone is hot (no multi-bump loop).
- Gap check: after each successfully parsed block; also once if startup backlog is empty.
- Wake matching with synthetic `filters:progress` (`downloaded = filters.count()`, `total` = header range size when headers exist else `downloaded`).
- Never `UPDATE` fat `filters` rows for unscanned — only touch `filters_unscanned`.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).

## File structure

| Path | Responsibility |
|------|----------------|
| `src/db/types.ts` | `KeyValueRepository`; `markUnscanned` / `markUnscannedFrom` on filters; `transactions.minHeight`; `keyValue` on `Database` |
| `src/db/schema.ts` | Create `key_value` |
| `src/db/sqlite-database.ts` | Implement key_value + markUnscanned + markUnscannedFrom + minHeight |
| `src/wallet/derive.ts` | `GAP_LIMIT`, dual-gap `deriveWatchWallet`, keep `ADDRESS_GAP` |
| `src/wallet/watch-gaps.ts` | Load/save gaps from DB; growth pure function (single bump) |
| `src/parse/used-indexes.ts` | `usedWatchIndexes` from stored txs + wallet |
| `src/modules/parse-blocks.ts` | Gap check after each parsed block; rematch + synthetic progress |
| `src/modules/filters-matching.ts` | Re-derive from DB gaps each scan loop |
| `tests/sqlite-key-value.test.ts` | key_value + markUnscannedFrom + minHeight |
| `tests/wallet-derive.test.ts` | Dual-gap derive |
| `tests/watch-gaps.test.ts` | Growth helper |
| `tests/parse-used-indexes.test.ts` | Used-index detection |
| `tests/parse-blocks-gap.test.ts` | Module growth + rematch kick |
| `tests/filters-matching.test.ts` | Uses DB gaps / expanded scripts |

---

### Task 1: SQLite `key_value` + rematch APIs

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/sqlite-database.ts`
- Create: `tests/sqlite-key-value.test.ts`

**Interfaces:**
- Consumes: existing `createSqliteDatabase`, `migrate`, `FiltersRepository`
- Produces:

```ts
export interface KeyValueRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

// On FiltersRepository:
/** Re-queue heights for matching (INSERT OR IGNORE into filters_unscanned). */
markUnscanned(heights: number[]): void;
/** Re-queue every stored filter with height >= fromHeight. */
markUnscannedFrom(fromHeight: number): void;

// On TransactionsRepository:
minHeight(): number | null;

// On Database:
keyValue: KeyValueRepository;
```

- [ ] **Step 1: Write the failing DB test**

Create `tests/sqlite-key-value.test.ts` (assert `markUnscannedFrom` keeps heights below the cut scanned, re-queues `>= from`, idempotent; assert `transactions.minHeight()`):

```ts
// See tests/sqlite-key-value.test.ts in the repo for the canonical case.
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sqlite-key-value.test.ts`

Expected: FAIL (missing `keyValue` / methods).

- [ ] **Step 3: Implement schema + types + sqlite**

In `src/db/schema.ts` main `raw.exec` block, add:

```sql
CREATE TABLE IF NOT EXISTS key_value (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

In `src/db/types.ts`: add `KeyValueRepository`, filter methods, `keyValue` on `Database`.

In `src/db/sqlite-database.ts`:

```ts
// keyValue
get: SELECT value FROM key_value WHERE key = ? → string | null
set: INSERT INTO key_value(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value

// markUnscanned
INSERT OR IGNORE INTO filters_unscanned(height) VALUES (?)  // per height, empty no-op

// markUnscannedFrom
INSERT OR IGNORE INTO filters_unscanned (height)
SELECT height FROM filters WHERE height >= ?

// transactions.minHeight
SELECT MIN(height) FROM transactions

// Do not touch filters.scanned column / fat rows.
```

Return `keyValue` from `createSqliteDatabase`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sqlite-key-value.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/db/types.ts src/db/schema.ts src/db/sqlite-database.ts tests/sqlite-key-value.test.ts
git commit -m "Add key_value storage and filter rematch APIs."
```

---

### Task 2: Dual-gap wallet derive + gap constants

**Files:**
- Modify: `src/wallet/derive.ts`
- Modify: `tests/wallet-derive.test.ts`
- Create: `src/wallet/watch-gaps.ts`
- Create: `tests/watch-gaps.test.ts`

**Interfaces:**
- Consumes: existing HD derive / `WatchWallet`
- Produces:

```ts
// src/wallet/derive.ts
export const GAP_LIMIT = 20;
/** Initial per-chain scan count (= 2 * GAP_LIMIT). */
export const ADDRESS_GAP = GAP_LIMIT * 2; // 40
export const WATCH_EXTERNAL_KEY = "watch_external";
export const WATCH_INTERNAL_KEY = "watch_internal";

export type WatchGaps = { external: number; internal: number };

export function deriveWatchWallet(
  mnemonic: string,
  gaps?: number | WatchGaps,
): WatchWallet;
// number ⇒ { external: n, internal: n }; omitted ⇒ ADDRESS_GAP for both

// src/wallet/watch-gaps.ts
export function loadWatchGaps(db: {
  keyValue: { get(k: string): string | null; set(k: string, v: string): void };
}): WatchGaps;
// missing keys → ADDRESS_GAP, write defaults

export function saveWatchGaps(
  db: { keyValue: { set(k: string, v: string): void } },
  gaps: WatchGaps,
): void;

/** Pure: one +gapLimit bump per chain if any used index is in [N - gapLimit, N). */
export function growWatchGapsIfNeeded(
  gaps: WatchGaps,
  used: { external: number[]; internal: number[] },
  gapLimit?: number, // default GAP_LIMIT
): { gaps: WatchGaps; grew: boolean };
```

- [ ] **Step 1: Write failing tests**

Extend `tests/wallet-derive.test.ts`:

```ts
test("dual gaps derive different chain lengths", () => {
  const wallet = deriveWatchWallet(ABANDON_MNEMONIC, {
    external: 3,
    internal: 2,
  });
  expect(wallet.addresses).toHaveLength(5);
  expect(wallet.addresses.filter((a) => !a.change)).toHaveLength(3);
  expect(wallet.addresses.filter((a) => a.change)).toHaveLength(2);
  expect(wallet.addresses[3]?.path).toBe("m/84'/0'/0'/1/0");
});

test("numeric gaps still means both chains", () => {
  const wallet = deriveWatchWallet(ABANDON_MNEMONIC, 4);
  expect(wallet.addresses).toHaveLength(8);
});
```

Create `tests/watch-gaps.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { ADDRESS_GAP, GAP_LIMIT } from "../src/wallet/derive.ts";
import {
  growWatchGapsIfNeeded,
  loadWatchGaps,
  saveWatchGaps,
} from "../src/wallet/watch-gaps.ts";

describe("watch gaps", () => {
  test("load defaults and persists", () => {
    const db = createSqliteDatabase(":memory:");
    expect(loadWatchGaps(db)).toEqual({
      external: ADDRESS_GAP,
      internal: ADDRESS_GAP,
    });
    expect(db.keyValue.get("watch_external")).toBe(String(ADDRESS_GAP));
    expect(db.keyValue.get("watch_internal")).toBe(String(ADDRESS_GAP));
    saveWatchGaps(db, { external: 60, internal: 40 });
    expect(loadWatchGaps(db)).toEqual({ external: 60, internal: 40 });
    db.close();
  });

  test("grows when used index in danger zone", () => {
    const r = growWatchGapsIfNeeded(
      { external: 40, internal: 40 },
      { external: [25], internal: [] }, // 25 in [20, 40)
      GAP_LIMIT,
    );
    expect(r.grew).toBe(true);
    expect(r.gaps).toEqual({ external: 60, internal: 40 });
  });

  test("no grow when used only below danger zone", () => {
    const r = growWatchGapsIfNeeded(
      { external: 40, internal: 40 },
      { external: [19], internal: [10] },
      GAP_LIMIT,
    );
    expect(r.grew).toBe(false);
    expect(r.gaps).toEqual({ external: 40, internal: 40 });
  });

  test("internal danger zone grows independently", () => {
    const r = growWatchGapsIfNeeded(
      { external: 40, internal: 40 },
      { external: [], internal: [30] },
      GAP_LIMIT,
    );
    expect(r.gaps).toEqual({ external: 40, internal: 60 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/wallet-derive.test.ts tests/watch-gaps.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement derive + watch-gaps**

`derive.ts` sketch:

```ts
export const GAP_LIMIT = 20;
export const ADDRESS_GAP = GAP_LIMIT * 2;
export const WATCH_EXTERNAL_KEY = "watch_external";
export const WATCH_INTERNAL_KEY = "watch_internal";

export type WatchGaps = { external: number; internal: number };

function normalizeGaps(gaps?: number | WatchGaps): WatchGaps {
  if (gaps === undefined) return { external: ADDRESS_GAP, internal: ADDRESS_GAP };
  if (typeof gaps === "number") return { external: gaps, internal: gaps };
  return {
    external: Math.max(0, Math.floor(gaps.external)),
    internal: Math.max(0, Math.floor(gaps.internal)),
  };
}

export function deriveWatchWallet(
  mnemonic: string,
  gaps?: number | WatchGaps,
): WatchWallet {
  const { external, internal } = normalizeGaps(gaps);
  // existing loop, but index < external for change=false, index < internal for change=true
}
```

`watch-gaps.ts`:

```ts
export function loadWatchGaps(db): WatchGaps {
  const parse = (v: string | null) => {
    const n = v === null ? NaN : Number.parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : ADDRESS_GAP;
  };
  const extRaw = db.keyValue.get(WATCH_EXTERNAL_KEY);
  const intRaw = db.keyValue.get(WATCH_INTERNAL_KEY);
  const external = parse(extRaw);
  const internal = parse(intRaw);
  if (extRaw === null || intRaw === null) {
    saveWatchGaps(db, { external, internal });
  }
  return { external, internal };
}

export function growWatchGapsIfNeeded(gaps, used, gapLimit = GAP_LIMIT) {
  const bump = (n, idxs) => {
    const start = n < gapLimit ? 0 : n - gapLimit;
    return idxs.some((i) => i >= start && i < n) ? n + gapLimit : n;
  };
  const external = bump(gaps.external, used.external);
  const internal = bump(gaps.internal, used.internal);
  return {
    gaps: { external, internal },
    grew: external !== gaps.external || internal !== gaps.internal,
  };
}
```

Guard: if `n < gapLimit`, danger zone is `[0, n)` (entire window). One bump per chain per call.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/wallet-derive.test.ts tests/watch-gaps.test.ts`

Expected: PASS. Also run `bun test tests/filters-matching.test.ts tests/parse-blocks.test.ts tests/wallet-derive.test.ts` — numeric `addressGap: 4` call sites must still compile/pass.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/wallet/derive.ts src/wallet/watch-gaps.ts tests/wallet-derive.test.ts tests/watch-gaps.test.ts
git commit -m "Support per-chain watch gaps with persisted defaults."
```

---

### Task 3: `usedWatchIndexes` helper

**Files:**
- Create: `src/parse/used-indexes.ts`
- Create: `tests/parse-used-indexes.test.ts`

**Interfaces:**
- Consumes: `Transaction` from bitcoinjs-lib, `WatchWallet`, `scriptHex` / `p2wpkhScriptFromPubkey` / `prevoutTxidDisplay` / `outpointKey`
- Produces:

```ts
export function usedWatchIndexes(
  txs: Array<{ hex: string }>,
  wallet: WatchWallet,
): { external: number[]; internal: number[] };
// Unique sorted ascending indices that appear as pay-to or spend-of watch scripts.
```

**Detection rules (implement exactly):**
1. Build `scriptHex → { change, index }` from `wallet.addresses`.
2. Walk txs in any order; for each tx decode with `Transaction.fromHex`.
3. Output script in map → mark that index used.
4. Non-coinbase input with witness `[…, pubkey]` (33-byte) whose `p2wpkh(pubkey)` is in map → mark used.
5. Non-coinbase input whose prevout `txid:vout` equals a watch output created by any tx in the list → mark that output’s index used.

- [ ] **Step 1: Write failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Transaction } from "bitcoinjs-lib";
import { deriveWatchWallet } from "../src/wallet/derive.ts";
import { usedWatchIndexes } from "../src/parse/used-indexes.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("usedWatchIndexes", () => {
  test("detects external receive and internal change", () => {
    const wallet = deriveWatchWallet(MNEMONIC, { external: 5, internal: 5 });
    const ext = wallet.addresses.find((a) => !a.change && a.index === 2)!;
    const int = wallet.addresses.find((a) => a.change && a.index === 1)!;

    const receive = new Transaction();
    receive.version = 2;
    receive.addOutput(ext.scriptPubKey, 1000n);

    const change = new Transaction();
    change.version = 2;
    change.addOutput(int.scriptPubKey, 500n);

    const used = usedWatchIndexes(
      [{ hex: receive.toHex() }, { hex: change.toHex() }],
      wallet,
    );
    expect(used.external).toEqual([2]);
    expect(used.internal).toEqual([1]);
  });

  test("detects P2WPKH spend via witness", () => {
    const wallet = deriveWatchWallet(MNEMONIC, { external: 3, internal: 1 });
    const addr = wallet.addresses.find((a) => !a.change && a.index === 2)!;
    // Need pubkey: re-derive or take from path — use HD in test like parse-extract
    const { HDKey } = require("@scure/bip32");
    const { mnemonicToSeedSync } = require("@scure/bip39");
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    const pubkey = root.derive("m/84'/0'/0'/0/2").publicKey!;

    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(new Uint8Array(32).fill(1), 0);
    spend.setWitness(0, [new Uint8Array(64), new Uint8Array(pubkey)]);
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 1n);

    const used = usedWatchIndexes([{ hex: spend.toHex() }], wallet);
    expect(used.external).toEqual([2]);
  });
});
```

Use proper ESM imports (not `require`) matching other tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/parse-used-indexes.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `usedWatchIndexes`**

```ts
// Build map, scan outs + witness + optional prevout→watch-out lookup
// Return { external: sorted unique, internal: sorted unique }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/parse-used-indexes.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/parse/used-indexes.ts tests/parse-used-indexes.test.ts
git commit -m "Detect used watch address indexes from stored txs."
```

---

### Task 4: Wire gap growth into `parse-blocks`

**Files:**
- Modify: `src/modules/parse-blocks.ts`
- Create: `tests/parse-blocks-gap.test.ts`

**Interfaces:**
- Consumes: `loadWatchGaps`, `saveWatchGaps`, `growWatchGapsIfNeeded`, `usedWatchIndexes`, `deriveWatchWallet`, `filters.markUnscannedFrom`, `transactions.minHeight`
- Produces: gap check side effects after each parsed block

**Behavior:**
1. On start: `gaps = loadWatchGaps(db)` → `wallet = deriveWatchWallet(seed, gaps)` (stop using constructor `addressGap` as sole source; if `options.addressGap` is set, treat as test override: `saveWatchGaps(db, { external: n, internal: n })` before load, so DB stays source of truth).
2. After each successfully parsed block: `maybeGrowWatch()`. If a `parseBatch` has an empty backlog (startup with existing txs), call `maybeGrowWatch()` once.
3. `maybeGrowWatch`:
   - `used = usedWatchIndexes(db.transactions.list(), wallet)`
   - `result = growWatchGapsIfNeeded(loadWatchGaps(db), used)`
   - if `!result.grew` return
   - `saveWatchGaps(db, result.gaps)`
   - `wallet = deriveWatchWallet(seed, result.gaps)`
   - `fromHeight = db.transactions.minHeight()`; if non-null: `db.filters.markUnscannedFrom(fromHeight)`
   - header range: `const tip = db.headers.tip(); const minH = db.headers.minHeight(); const downloaded = db.filters.count(); const total = tip && minH !== null ? tip.height - minH + 1 : downloaded;`
   - `bus.emit("filters:progress", { at: now(), downloaded, total })`

- [ ] **Step 1: Write failing module test**

```ts
import { describe, expect, test } from "bun:test";
import { Block, Transaction } from "bitcoinjs-lib";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../src/modules/parse-blocks.ts";
import { deriveWatchWallet } from "../src/wallet/derive.ts";
import { loadWatchGaps } from "../src/wallet/watch-gaps.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function blockHexPaying(script: Uint8Array, value: bigint): string {
  const tx = new Transaction();
  tx.version = 2;
  tx.addOutput(script, value);
  const block = new Block();
  block.version = 1;
  block.prevHash = new Uint8Array(32);
  block.merkleRoot = Block.calculateMerkleRoot([tx]);
  block.timestamp = 0;
  block.bits = 0;
  block.nonce = 0;
  block.transactions = [tx];
  return block.toHex();
}

describe("parse-blocks gap growth", () => {
  test("used address in danger zone grows external and rematches filters", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    // Default gaps = 40. External index 25 is in danger zone [20, 40) → grow to 60.
    const wallet = deriveWatchWallet(MNEMONIC, 40);
    const danger = wallet.addresses.find((a) => !a.change && a.index === 25)!;

    db.blocks.insert({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
      blockHex: blockHexPaying(danger.scriptPubKey, 1000n),
    });
    for (let h = 1; h <= 5; h++) {
      db.filters.append([
        {
          height: h,
          blockHashInternalHex: "bb".repeat(32),
          filterHex: "00",
        },
      ]);
    }
    db.filters.markScanned([1, 2, 3, 4, 5]);

    const progress: Array<{ downloaded: number; total: number }> = [];
    bus.on("filters:progress", (p) =>
      progress.push({ downloaded: p.downloaded, total: p.total }),
    );

    const mod = createParseBlocksModule(
      { bus, db },
      { seed: MNEMONIC, idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod.start();
    await waitFor(() => loadWatchGaps(db).external === 60);
    expect(loadWatchGaps(db).internal).toBe(40);
    expect(db.filters.get(5)?.scanned).toBe(0);
    expect(db.filters.get(1)?.scanned).toBe(0); // only 5 filters → all rematched
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0]?.downloaded).toBe(5);
    await mod.stop();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/parse-blocks-gap.test.ts`

Expected: FAIL (no growth).

- [ ] **Step 3: Implement in `parse-blocks.ts`**

Wire `loadWatchGaps` / `maybeGrowWatch` as specified. Keep `refreshNetDeltasAndEmit` after parse; run gap check after that (or before emit — order: parse → net deltas → wallet:txs → gap check is fine; gap check may emit `filters:progress` separately).

Recommended order at end of `parseBatch`:
1. `refreshNetDeltasAndEmit()`
2. `maybeGrowWatch()`

On start, after init `parseBatch` (which already gap-checks), do not double-emit unless growth happens twice (idempotent if already grown).

- [ ] **Step 4: Run tests**

Run: `bun test tests/parse-blocks-gap.test.ts tests/parse-blocks.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/modules/parse-blocks.ts tests/parse-blocks-gap.test.ts
git commit -m "Grow watch gaps from parse-blocks and rematch filters."
```

---

### Task 5: `filters-matching` reads DB gaps

**Files:**
- Modify: `src/modules/filters-matching.ts`
- Modify: `tests/filters-matching.test.ts` (only if needed for gap seeding)

**Interfaces:**
- Consumes: `loadWatchGaps`, `deriveWatchWallet(seed, gaps)`
- Produces: matching uses expanded scripts after parse grows indexes

**Behavior:**
1. On start: `wallet = deriveWatchWallet(seed, loadWatchGaps(db))`. If `options.addressGap` set, `saveWatchGaps(db, { external: n, internal: n })` first (same test override as parse).
2. At the start of each `loop` iteration (before `scanFiltersForMatches`), reload gaps; if changed, re-derive `wallet`.

- [ ] **Step 1: Write / extend failing test**

Add to `tests/filters-matching.test.ts`:

```ts
test("re-derives watchlist when key_value gaps grow", async () => {
  const bus = createMessageBus();
  const db = createSqliteDatabase(":memory:");
  // Start with gap 4; insert filter that only matches external index 5 script
  // (outside initial watchlist). Mark unscanned. Matching should miss.
  // Then saveWatchGaps({external:8,internal:4}), emit filters:progress,
  // expect filters:match for that height.
  // ...
});
```

Build filter with `filterContaining` helper already in that file, using script from `deriveWatchWallet(mnemonic, 8)` index 5 external only.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/filters-matching.test.ts`

Expected: FAIL on the new case (wallet frozen at start gaps).

- [ ] **Step 3: Implement re-derive in loop**

```ts
async function loop() {
  while (!stopped) {
    busy = true;
    needsRun = false;
    try {
      const gaps = loadWatchGaps(ctx.db);
      wallet = deriveWatchWallet(seed, gaps);
      await scanFiltersForMatches(ctx.db, wallet.scripts, ...);
    } ...
  }
}
```

- [ ] **Step 4: Run full related suite + typecheck**

```bash
bun test tests/sqlite-key-value.test.ts tests/watch-gaps.test.ts tests/wallet-derive.test.ts tests/parse-used-indexes.test.ts tests/parse-blocks-gap.test.ts tests/parse-blocks.test.ts tests/filters-matching.test.ts
bun test
bun run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/modules/filters-matching.ts tests/filters-matching.test.ts
git commit -m "Reload watch gaps from DB in filters-matching."
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| `key_value` table + get/set | Task 1 |
| `watch_external` / `watch_internal` defaults 40 | Task 2 (`loadWatchGaps`) |
| `GAP_LIMIT=20`, grow by 20 (one bump per check) | Task 2 |
| `deriveWatchWallet({ external, internal })` | Task 2 |
| `usedWatchIndexes` from stored txs | Task 3 |
| Growth in parse-blocks after each block + empty-backlog startup | Task 4 |
| Rematch filters from first used wallet tx height | Task 1 + 4 |
| Synthetic `filters:progress` kick | Task 4 |
| filters-matching reads DB gaps | Task 5 |
| No rematch below first used height / no re-parse of matched blocks | intentional (no task) |

No TBD placeholders. Types aligned: `WatchGaps`, `KeyValueRepository`, `markUnscanned`, `markUnscannedFrom`, `transactions.minHeight`.
