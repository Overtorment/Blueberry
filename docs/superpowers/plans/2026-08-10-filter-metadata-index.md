# Filter Metadata Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a covering filter metadata index and measure its effect on the live wallet database.

**Architecture:** `ensureSchema` creates one index on filter height and block hash. Existing repository queries remain unchanged and let SQLite select the covering index.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, SQLite

## Global Constraints

- Do not read wallet secrets or transaction payloads.
- Do not change repository interfaces.
- Use the approved live database for the after benchmark.
- Do not commit changes unless the user requests a commit.

---

### Task 1: Record the baseline

**Files:**
- Read: `blueberry.data/blueberry.sqlite`

**Interfaces:**
- Consumes: Existing `filters` and `headers` tables.
- Produces: Baseline timings and query plans for comparison.

- [ ] **Step 1: Record query plans**

Run `EXPLAIN QUERY PLAN` for:

```sql
SELECT COUNT(*) FROM filters;
SELECT f.height
FROM filters f
JOIN headers h ON h.height = f.height
WHERE f.height >= 556416
  AND f.height <= 961896
  AND f.block_hash_internal_hex != h.hash_internal_hex
ORDER BY f.height
LIMIT 1;
SELECT SUM(height)
FROM filters
WHERE height >= 556416 AND height <= 961896;
```

Expected: the queries read the `filters` table primary-key B-tree.

- [ ] **Step 2: Record five timings for each query**

Use `/usr/bin/time` with `sqlite3 -readonly`. Discard query output only.

Expected: metadata queries take about 0.4 seconds on the current live database.

### Task 2: Add the schema index with TDD

**Files:**
- Modify: `tests/unit/sqlite-filters.test.ts`
- Modify: `src/db/schema.ts:76-80`

**Interfaces:**
- Consumes: `ensureSchema(raw: BunDatabase): void`.
- Produces: SQLite index `filters_height_hash(height, block_hash_internal_hex)`.

- [ ] **Step 1: Write the failing schema test**

Add these imports:

```typescript
import { Database as BunDatabase } from "bun:sqlite";
import { ensureSchema } from "../../src/db/schema.ts";
```

Add this test:

```typescript
test("schema creates a covering filter metadata index", () => {
  const raw = new BunDatabase(":memory:");
  ensureSchema(raw);
  const columns = raw
    .query("PRAGMA index_info('filters_height_hash')")
    .all() as Array<{ seqno: number; name: string }>;
  expect(columns.map((column) => column.name)).toEqual([
    "height",
    "block_hash_internal_hex",
  ]);
  raw.close();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
bun test tests/unit/sqlite-filters.test.ts
```

Expected: FAIL because `PRAGMA index_info` returns no columns.

- [ ] **Step 3: Add the minimal index**

Add this statement to `ensureSchema`:

```sql
CREATE INDEX IF NOT EXISTS filters_height_hash
  ON filters(height, block_hash_internal_hex);
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
bun test tests/unit/sqlite-filters.test.ts
```

Expected: all tests pass.

### Task 3: Create and benchmark the live index

**Files:**
- Modify through SQLite schema initialization: `blueberry.data/blueberry.sqlite`

**Interfaces:**
- Consumes: `createSqliteDatabase(path: string): Database`.
- Produces: Live index and before/after benchmark comparison.

- [ ] **Step 1: Create the index through application initialization**

Run:

```bash
/usr/bin/time -f '%e seconds' bun -e \
  'import { createSqliteDatabase } from "./src/db/sqlite-database.ts"; const db = createSqliteDatabase("./blueberry.data/blueberry.sqlite"); db.close();'
```

Expected: exit code 0.

- [ ] **Step 2: Verify the query plans**

Run the same `EXPLAIN QUERY PLAN` statements from Task 1.

Expected: metadata reads use `COVERING INDEX filters_height_hash`.

- [ ] **Step 3: Repeat the timing benchmark**

Run each Task 1 query five times with the same command structure.

Expected: lower median times than the baseline.

- [ ] **Step 4: Measure index size**

Run:

```sql
SELECT SUM(pgsize) AS bytes
FROM dbstat
WHERE name = 'filters_height_hash';
```

Expected: a nonzero size near 35–40 MiB.

### Task 4: Final verification

**Files:**
- Verify: `src/db/schema.ts`
- Verify: `tests/unit/sqlite-filters.test.ts`

**Interfaces:**
- Consumes: Completed schema change.
- Produces: Test and type-check evidence.

- [ ] **Step 1: Run storage tests**

Run:

```bash
bun test tests/unit/sqlite-filters.test.ts tests/unit/sqlite-headers.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run type checking**

Run:

```bash
bun run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Review the diff**

Run:

```bash
git diff --check
git diff -- src/db/schema.ts tests/unit/sqlite-filters.test.ts docs/superpowers/specs/2026-08-10-filter-metadata-index-design.md docs/superpowers/plans/2026-08-10-filter-metadata-index.md
```

Expected: no whitespace errors and only the approved index work.
