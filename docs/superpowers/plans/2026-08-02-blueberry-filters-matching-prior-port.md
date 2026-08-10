# blueberry Filters Matching Prior Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Worker-based address-gap filter matcher with a prior-style full-watchlist scan over a per-filter `scanned` flag, keeping the existing module/bus/TUI interface.

**Architecture:** Thin `filters-matching` module keeps start/stop, kick-on-`filters:progress`, and bus emits. New `src/match/*` holds `FilterMatcher`, bip158 adapter, and a batch scan helper over SQLite. Schema drops match cursors for `scanned INTEGER`; migration resets all rows to unscanned.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bip158` (`matchAnyBasicFilters`), existing MessageBus + Module pattern. No new npm dependencies. Use the algorithm/shape described in this plan; do not copy from other codebases.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-02-blueberry-filters-matching-prior-port-design.md`.
- Keep bus shapes: `matching:progress { at, matched, total }` (`matched` = scanned count), `filters:match { height, blockHashInternalHex }`, kick on `filters:progress`.
- No Worker / `filters-match-client` / `filters-match-worker`.
- Full watchlist (`wallet.scripts`) per batch; no `matchedExternal` / `matchedInternal` / `scriptsNeedingMatch`.
- Migration resets: every filter `scanned = 0`.
- Modules communicate via bus + injected `db` only.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).
- Do not change blocks-download or TUI layout beyond `countScanned` seed wiring.

## File structure

| Path | Responsibility |
|------|----------------|
| `src/db/types.ts` | `FilterRecord.scanned`; scanned repo methods |
| `src/db/schema.ts` | Create/migrate `scanned`; drop cursor indexes |
| `src/db/sqlite-database.ts` | Implement scanned APIs |
| `src/match/types.ts` | `FilterMatcher` interface (from the prior scanner) |
| `src/match/bip158.ts` | `createBip158FilterMatcher()` |
| `src/match/scan.ts` | One-batch (or multi-batch pass) scan helper |
| `src/modules/filters-matching.ts` | Module shell only |
| `src/modules/filters-match-client.ts` | **DELETE** |
| `src/modules/filters-match-worker.ts` | **DELETE** |
| `src/wallet/derive.ts` | Remove `scriptsNeedingMatch` |
| `src/tui/tui-module.ts` | Seed via `countScanned()` |
| `tests/sqlite-filters.test.ts` | Scanned API + migration reset |
| `tests/filters-matching.test.ts` | Rewrite for scanned model |
| `tests/wallet-derive.test.ts` | Drop cursor-helper test |
| `tests/tui-matching-progress.test.ts` | Seed `scanned` |

---

### Task 1: SQLite `scanned` flag

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/sqlite-database.ts`
- Modify: `tests/sqlite-filters.test.ts`
- Modify: `tests/tui-matching-progress.test.ts` (compile fix for append shape)

**Interfaces:**
- Consumes: existing `createSqliteDatabase`, `migrate`
- Produces:
  - `FilterRecord`: `{ height, blockHashInternalHex, filterHex, scanned }` (`scanned` is `0 | 1`)
  - `FiltersRepository.append(rows)` where rows omit/optionally set `scanned` (default `0`)
  - `listNeedingMatch(limit: number): FilterRecord[]`
  - `countScanned(): number`
  - `markScanned(heights: number[]): void`
  - Removed: `FilterMatchProgress`, `countMatched`, `updateMatchProgress`, gap args

- [ ] **Step 1: Rewrite the failing sqlite match-progress test**

Replace the test `"match progress defaults, listNeedingMatch, updateMatchProgress"` in `tests/sqlite-filters.test.ts` with:

```ts
test("scanned defaults, listNeedingMatch, markScanned, countScanned", () => {
  const db = createSqliteDatabase(":memory:");
  db.filters.append([
    {
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
      filterHex: "01",
    },
    {
      height: 11,
      blockHashInternalHex: "bb".repeat(32),
      filterHex: "02",
    },
    {
      height: 12,
      blockHashInternalHex: "cc".repeat(32),
      filterHex: "03",
    },
  ]);
  expect(db.filters.get(10)).toMatchObject({ scanned: 0 });
  expect(db.filters.countScanned()).toBe(0);
  expect(db.filters.listNeedingMatch(10).map((r) => r.height)).toEqual([
    10, 11, 12,
  ]);
  expect(db.filters.listNeedingMatch(1).map((r) => r.height)).toEqual([10]);

  db.filters.markScanned([10, 12]);
  expect(db.filters.get(10)?.scanned).toBe(1);
  expect(db.filters.get(11)?.scanned).toBe(0);
  expect(db.filters.get(12)?.scanned).toBe(1);
  expect(db.filters.countScanned()).toBe(2);
  expect(db.filters.listNeedingMatch(10).map((r) => r.height)).toEqual([11]);

  db.filters.markScanned([11]);
  expect(db.filters.listNeedingMatch(10)).toEqual([]);
  expect(db.filters.countScanned()).toBe(3);
  db.close();
});
```

Also add a migration test (file-backed temp DB):

```ts
test("migrate resets legacy cursor columns to unscanned", () => {
  const dir = mkdtempSync(join(tmpdir(), "blueberry-filters-migrate-"));
  const path = join(dir, "db.sqlite");
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE filters (
      height INTEGER PRIMARY KEY,
      block_hash_internal_hex TEXT NOT NULL,
      filter_hex TEXT NOT NULL,
      matched_external INTEGER NOT NULL DEFAULT 0,
      matched_internal INTEGER NOT NULL DEFAULT 0
    );
  `);
  raw
    .query(
      `INSERT INTO filters (height, block_hash_internal_hex, filter_hex, matched_external, matched_internal)
       VALUES (1, ?, 'aa', 40, 40)`,
    )
    .run("11".repeat(32));
  raw.close();

  const db = createSqliteDatabase(path);
  expect(db.filters.get(1)).toMatchObject({ scanned: 0 });
  expect(db.filters.countScanned()).toBe(0);
  db.close();
});
```

(Use `bun:sqlite` `Database` + `node:fs` `mkdtempSync` / `node:os` `tmpdir` / `node:path` `join` — same patterns as other file-backed tests if present; otherwise add those imports.)

Update `tests/tui-matching-progress.test.ts` append payloads so TypeScript compiles after the type change (use `scanned: 1` / omit for 0) — the TUI seed assertion will still fail until Task 5; for now only fix types that block `bun test tests/sqlite-filters.test.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sqlite-filters.test.ts`
Expected: FAIL — `countScanned` / `markScanned` / `scanned` missing.

- [ ] **Step 3: Update types**

In `src/db/types.ts`, change `FilterRecord` to:

```ts
export type FilterRecord = {
  height: number;
  blockHashInternalHex: string;
  filterHex: string;
  /** 0 = needs match, 1 = fully scanned against current watchlist. */
  scanned: number;
};
```

Remove `FilterMatchProgress`.

Replace match methods on `FiltersRepository`:

```ts
append(
  rows: Array<
    Omit<FilterRecord, "scanned"> & Partial<Pick<FilterRecord, "scanned">>
  >,
): void;
listNeedingMatch(limit: number): FilterRecord[];
countScanned(): number;
markScanned(heights: number[]): void;
```

- [ ] **Step 4: Update schema migration**

In `src/db/schema.ts`:

- New `CREATE TABLE filters` uses `scanned INTEGER NOT NULL DEFAULT 0` (no cursor columns).
- After create, migrate existing DBs:
  - If `scanned` missing → `ALTER TABLE filters ADD COLUMN scanned INTEGER NOT NULL DEFAULT 0`
  - Always on migrate when upgrading from cursor era: `UPDATE filters SET scanned = 0` once when the column was just added **or** when cursor indexes still exist (detect `filters_matched_ext_height` via `sqlite_master` / drop them). Simplest approved approach from spec: when adding `scanned`, set all to 0; also `UPDATE filters SET scanned = 0` if legacy cursor indexes exist before dropping them so every upgrade rematches.
  - `DROP INDEX IF EXISTS filters_matched_ext_height`
  - `DROP INDEX IF EXISTS filters_matched_int_height`
  - `CREATE INDEX IF NOT EXISTS filters_scanned_height ON filters(scanned, height)`

Do not require dropping the obsolete columns.

- [ ] **Step 5: Implement repository methods**

In `src/db/sqlite-database.ts`:

- `FilterRow.scanned` (and map in `rowToFilter`). Keep reading obsolete cursor columns only if still present — prefer selecting explicit columns: `height, block_hash_internal_hex, filter_hex, scanned`.
- `insertFilter`: insert `scanned` (default 0).
- `listNeedingMatch(limit)`:

```sql
SELECT height, block_hash_internal_hex, filter_hex, scanned
FROM filters
WHERE scanned = 0
ORDER BY height ASC
LIMIT ?
```

- `countScanned()`: `SELECT COUNT(*) FROM filters WHERE scanned = 1`
- `markScanned(heights)`: no-op if empty; for contiguous height runs use one `UPDATE … WHERE height >= ? AND height <= ?`; else transaction of per-height updates `SET scanned = 1`.

Remove `updateFilterMatch`, gap-based queries, `countMatched`, `updateMatchProgress`.

- [ ] **Step 6: Run sqlite tests**

Run: `bun test tests/sqlite-filters.test.ts`
Expected: PASS

- [ ] **Step 7: Commit (skip unless user asked)**

```bash
git add src/db/types.ts src/db/schema.ts src/db/sqlite-database.ts tests/sqlite-filters.test.ts tests/tui-matching-progress.test.ts
git commit -m "Replace filter match cursors with scanned flag."
```

---

### Task 2: `FilterMatcher` + bip158 adapter

**Files:**
- Create: `src/match/types.ts`
- Create: `src/match/bip158.ts`
- Create: `tests/match-bip158.test.ts`

**Interfaces:**
- Consumes: `bip158.matchAnyBasicFilters`
- Produces:
  - `FilterMatcher` with `matchAnyMany(filterBytesList, blockHashDisplayList, scripts): boolean[]` and `matchAny(...): boolean`
  - `createBip158FilterMatcher(): FilterMatcher`

- [ ] **Step 1: Write failing test**

Create `tests/match-bip158.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildBasicFilter, bytesToHex, hexToBytes } from "bip158";
import { createBip158FilterMatcher } from "../src/match/bip158.ts";

function displayHash(internalHex: string): Uint8Array {
  const internal = hexToBytes(internalHex);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = internal[31 - i]!;
  return out;
}

describe("bip158 FilterMatcher", () => {
  test("matchAnyMany hits and misses aligned with inputs", () => {
    const matcher = createBip158FilterMatcher();
    const script = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(1)]);
    const other = new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(2)]);
    const h1 = "11".repeat(32);
    const h2 = "22".repeat(32);
    const f1 = buildBasicFilter({
      blockHashDisplay: displayHash(h1),
      elements: [script],
    });
    const f2 = buildBasicFilter({
      blockHashDisplay: displayHash(h2),
      elements: [other],
    });
    expect(
      matcher.matchAnyMany([f1, f2], [displayHash(h1), displayHash(h2)], [script]),
    ).toEqual([true, false]);
    expect(matcher.matchAny(f1, displayHash(h1), [script])).toBe(true);
    expect(matcher.matchAny(f2, displayHash(h2), [script])).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/match-bip158.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement matcher**

`src/match/types.ts` — use this shape:

```ts
export type FilterMatcher = {
  matchAnyMany(
    filterBytesList: Uint8Array[],
    blockHashDisplayList: Uint8Array[],
    scripts: Uint8Array[],
  ): boolean[];
  matchAny(
    filterBytes: Uint8Array,
    blockHashDisplay: Uint8Array,
    scripts: Uint8Array[],
  ): boolean;
};
```

`src/match/bip158.ts` — same as prior `createBip158FilterMatcher` wrapping `matchAnyBasicFilters`.

- [ ] **Step 4: Run test**

Run: `bun test tests/match-bip158.test.ts`
Expected: PASS

- [ ] **Step 5: Commit (skip unless user asked)**

```bash
git add src/match/types.ts src/match/bip158.ts tests/match-bip158.test.ts
git commit -m "Add bip158 FilterMatcher adapter."
```

---

### Task 3: Scan helper

**Files:**
- Create: `src/match/scan.ts`
- Create: `tests/match-scan.test.ts`

**Interfaces:**
- Consumes: `Database` (`filters.listNeedingMatch`, `filters.markScanned`, `matchedBlocks.insert`), `FilterMatcher`, `WatchWallet.scripts`
- Produces:

```ts
export const MATCH_FILTER_BATCH_SIZE = 1000;
export const MATCH_PROGRESS_EVERY = 50;

export type MatchScanCallbacks = {
  onMatch?: (m: { height: number; blockHashInternalHex: string }) => void;
  onProgress?: (p: { matched: number; total: number }) => void;
};

export type MatchScanOptions = {
  batchSize?: number;
  progressEvery?: number;
  yieldFn?: () => Promise<void>;
  /** Stop cooperative loop (module stop). */
  shouldContinue?: () => boolean;
};

/** Scan unscanned filters until empty or shouldContinue is false. Returns rows advanced. */
export async function scanFiltersForMatches(
  db: Database,
  scripts: Uint8Array[],
  matcher: FilterMatcher,
  callbacks?: MatchScanCallbacks,
  options?: MatchScanOptions,
): Promise<number>;
```

Algorithm (port prior `flushPending` ideas onto SQLite):

1. `total = db.filters.count()`, `matched = db.filters.countScanned()`, emit progress once.
2. Loop:
   - if `shouldContinue?.() === false` return advanced
   - `batch = db.filters.listNeedingMatch(batchSize)`; if empty, emit reconcile progress and return
   - decode each row: `filterBytes = Buffer.from(filterHex, "hex")`, display hash = reverse of internal hex bytes
   - `hits = matcher.matchAnyMany(filters, hashes, scripts)`
   - `await yieldFn()` (default: `setImmediate` promise)
   - collect heights; for each hit where `matchedBlocks.insert` returns true → `onMatch`
   - `markScanned(heights)`; bump local `matched`; every `progressEvery` rows call `onProgress` + yield
3. After each batch, yield once more.

Helper for internal→display hash can live in `scan.ts` (same byte-reverse as current module / prior `toDisplayHash`).

- [ ] **Step 1: Write failing scan tests**

`tests/match-scan.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildBasicFilter, bytesToHex, hexToBytes } from "bip158";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createBip158FilterMatcher } from "../src/match/bip158.ts";
import { scanFiltersForMatches } from "../src/match/scan.ts";
import { deriveWatchWallet } from "../src/wallet/derive.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function displayHash(internalHex: string): Uint8Array {
  const internal = hexToBytes(internalHex);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = internal[31 - i]!;
  return out;
}

function append(db: ReturnType<typeof createSqliteDatabase>, height: number, internalHex: string, elements: Uint8Array[]) {
  db.filters.append([{
    height,
    blockHashInternalHex: internalHex,
    filterHex: bytesToHex(buildBasicFilter({
      blockHashDisplay: displayHash(internalHex),
      elements,
    })),
  }]);
}

describe("scanFiltersForMatches", () => {
  test("hit inserts matched block and marks scanned; miss only marks scanned", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    const hitHash = "11".repeat(32);
    const missHash = "22".repeat(32);
    append(db, 100, hitHash, [wallet.scripts[0]!]);
    append(db, 101, missHash, [new Uint8Array([0x00, 0x14, ...new Uint8Array(20).fill(0xab)])]);
    const matches: number[] = [];
    const advanced = await scanFiltersForMatches(
      db,
      wallet.scripts,
      createBip158FilterMatcher(),
      { onMatch: (m) => matches.push(m.height) },
      { yieldFn: async () => {} },
    );
    expect(advanced).toBe(2);
    expect(matches).toEqual([100]);
    expect(db.matchedBlocks.count()).toBe(1);
    expect(db.filters.countScanned()).toBe(2);
    expect(db.filters.listNeedingMatch(10)).toEqual([]);
    db.close();
  });

  test("skips already scanned rows", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    append(db, 200, "33".repeat(32), [wallet.scripts[0]!]);
    db.filters.markScanned([200]);
    const matches: number[] = [];
    const advanced = await scanFiltersForMatches(
      db,
      wallet.scripts,
      createBip158FilterMatcher(),
      { onMatch: (m) => matches.push(m.height) },
      { yieldFn: async () => {} },
    );
    expect(advanced).toBe(0);
    expect(matches).toEqual([]);
    expect(db.matchedBlocks.count()).toBe(0);
    db.close();
  });

  test("does not re-emit match for existing matched_blocks row", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    const hash = "44".repeat(32);
    append(db, 300, hash, [wallet.scripts[0]!]);
    db.matchedBlocks.insert({ height: 300, blockHashInternalHex: hash });
    // Reset scanned so rematch runs (migration-style).
    // mark via raw path: delete+append or UPDATE — use mark only after clear:
    // For this test, append left scanned=0; insert matched first, then scan.
    const matches: number[] = [];
    await scanFiltersForMatches(
      db,
      wallet.scripts,
      createBip158FilterMatcher(),
      { onMatch: (m) => matches.push(m.height) },
      { yieldFn: async () => {} },
    );
    expect(matches).toEqual([]);
    expect(db.filters.get(300)?.scanned).toBe(1);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/match-scan.test.ts`
Expected: FAIL — `scanFiltersForMatches` missing.

- [ ] **Step 3: Implement `src/match/scan.ts`**

Port the batching/yield/commit loop from prior `scanFiltersForMatches`, adapted to the SQLite APIs above. Keep CPU work sync inside `matchAnyMany`; yield after the match call and on progress cadence.

- [ ] **Step 4: Run test**

Run: `bun test tests/match-scan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit (skip unless user asked)**

```bash
git add src/match/scan.ts tests/match-scan.test.ts
git commit -m "Add SQLite filter match scan helper."
```

---

### Task 4: Module shell + delete Worker

**Files:**
- Modify: `src/modules/filters-matching.ts`
- Delete: `src/modules/filters-match-client.ts`
- Delete: `src/modules/filters-match-worker.ts`
- Modify: `tests/filters-matching.test.ts`

**Interfaces:**
- Consumes: `scanFiltersForMatches`, `createBip158FilterMatcher`, `deriveWatchWallet`, `config.seed`
- Produces: unchanged `createFiltersMatchingModule(ctx, options?) → Module`

```ts
export type FiltersMatchingOptions = {
  seed?: string;
  addressGap?: number;
  batchSize?: number;
  progressEvery?: number;
  yieldFn?: () => Promise<void>;
  matcher?: FilterMatcher;
};
```

Module behavior:

- `start`: emit starting → `reconcileProgress(true)` using `countScanned()` / `filters.count()` → derive wallet → on `filters:progress` set dirty or kick → emit running → loop
- loop: `busy=true`; `await scanFiltersForMatches(...)` with callbacks emitting bus events; on throw → status error; `busy=false`; if dirty continue else `waitForKick`
- `stop`: unsubscribe, wake, await loop, status stopped
- Remove `syncMatchFn` export and all Worker code

- [ ] **Step 1: Rewrite module tests for scanned model**

Rewrite `tests/filters-matching.test.ts` (keep wait helpers / abandon mnemonic / bip158 filter builders). Cases:

1. Hit emits `filters:match`, inserts matched block, marks `scanned === 1`
2. Miss marks scanned, no emit, no matched block
3. Already scanned filter skipped (seed `scanned: 1` via append)
4. `matching:progress` on start + after batches (`batchSize: 1`)
5. Continues while matched blocks need download (same intent as current test)
6. Idle resumes on `filters:progress`; busy dirty-bit drains new work

Drop all partial-cursor / `scriptsNeedingMatch` cases. Stop importing `syncMatchFn`; construct module with default matcher + `{ yieldFn: async () => {} }` where timing matters.

Example hit test shape:

```ts
const mod = createFiltersMatchingModule(
  { bus, db },
  { seed: ABANDON_MNEMONIC, addressGap: 4, yieldFn: async () => {} },
);
await mod.start();
await waitFor(() => hits.length === 1 && db.filters.get(100)?.scanned === 1);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/filters-matching.test.ts`
Expected: FAIL against old module / missing APIs.

- [ ] **Step 3: Rewrite module + delete worker files**

Replace `src/modules/filters-matching.ts` with the shell described above. Delete the two worker files. Grep the repo for `filters-match-client`, `filters-match-worker`, `syncMatchFn`, `scriptsNeedingMatch` and clear leftovers.

- [ ] **Step 4: Run module tests**

Run: `bun test tests/filters-matching.test.ts`
Expected: PASS

- [ ] **Step 5: Commit (skip unless user asked)**

```bash
git add src/modules/filters-matching.ts tests/filters-matching.test.ts
git rm src/modules/filters-match-client.ts src/modules/filters-match-worker.ts
git commit -m "Replace filters-matching guts with prior-style scan."
```

---

### Task 5: Wallet + TUI seed cleanup

**Files:**
- Modify: `src/wallet/derive.ts`
- Modify: `tests/wallet-derive.test.ts`
- Modify: `src/tui/tui-module.ts`
- Modify: `tests/tui-matching-progress.test.ts`

**Interfaces:**
- Consumes: `countScanned()`
- Produces: derive without `scriptsNeedingMatch`; TUI seeds `matched: ctx.db.filters.countScanned()`

- [ ] **Step 1: Update failing tests**

In `tests/wallet-derive.test.ts`, delete the `"scriptsNeedingMatch returns only unchecked indexes"` test and its import.

In `tests/tui-matching-progress.test.ts`, seed filters with `scanned: 1` / default 0:

```ts
db.filters.append([
  {
    height: 1,
    blockHashInternalHex: "11".repeat(32),
    filterHex: "aa",
    scanned: 1,
  },
  {
    height: 2,
    blockHashInternalHex: "22".repeat(32),
    filterHex: "bb",
  },
]);
```

Expect seed `{ matched: 1, total: 2, percent: 50 }` still.

- [ ] **Step 2: Run tests to verify failure mode**

Run: `bun test tests/wallet-derive.test.ts tests/tui-matching-progress.test.ts`
Expected: TUI seed fails if still on `countMatched`; wallet may still pass if helper exists.

- [ ] **Step 3: Implement cleanup**

- Remove `scriptsNeedingMatch` from `src/wallet/derive.ts`
- In `src/tui/tui-module.ts`, replace `countMatched(ADDRESS_GAP, ADDRESS_GAP)` with `countScanned()`; remove `ADDRESS_GAP` import if unused

- [ ] **Step 4: Run tests**

Run: `bun test tests/wallet-derive.test.ts tests/tui-matching-progress.test.ts`
Expected: PASS

- [ ] **Step 5: Full related suite**

Run: `bun test tests/sqlite-filters.test.ts tests/match-bip158.test.ts tests/match-scan.test.ts tests/filters-matching.test.ts tests/wallet-derive.test.ts tests/tui-matching-progress.test.ts`
Expected: all PASS

- [ ] **Step 6: Commit (skip unless user asked)**

```bash
git add src/wallet/derive.ts tests/wallet-derive.test.ts src/tui/tui-module.ts tests/tui-matching-progress.test.ts
git commit -m "Drop match cursors from wallet helper and TUI seed."
```

---

## Self-review vs spec

| Spec requirement | Task |
|------------------|------|
| Thin module + scan helper | Tasks 3–4 |
| Full watchlist, no gap cursors | Tasks 1, 3–5 |
| `scanned` flag + reset migration | Task 1 |
| Sync bip158, no Worker | Tasks 2–4 |
| Bus shapes unchanged | Task 4 |
| Kick / dirty / idle | Task 4 |
| Delete worker files | Task 4 |
| Delete `scriptsNeedingMatch` | Task 5 |
| TUI `countScanned` seed | Task 5 |
| Tests rewritten | Tasks 1–5 |
| Out of scope: blocks-download / TUI layout / flat store | Not tasked |

No TBD placeholders. Types consistent: `scanned` number 0|1, `listNeedingMatch(limit)`, `countScanned`, `markScanned`, `FilterMatcher`, `scanFiltersForMatches`.
`)