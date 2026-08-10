# Atomic Filter Wipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete filters and filter headers in one SQLite transaction, including the optional bootstrap prev header.

**Architecture:** Add `Database.wipeFiltersFrom`. Point `filters-download` wipe helper at that method. Keep narrow `deleteFrom` methods for existing tests.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`

## Global Constraints

- Do not delete matched blocks, blocks, parsed markers, transactions, or headers.
- Do not commit unless the user asks.
- Prefer TDD: failing test first.

---

### Task 1: Failing wipe test

**Files:**
- Modify: `tests/unit/sqlite-filters.test.ts`

**Interfaces:**
- Consumes: future `db.wipeFiltersFrom(height, options?)`.
- Produces: RED then GREEN coverage for atomic wipe behavior.

- [ ] **Step 1: Write the failing test**

Add:

```typescript
test("wipeFiltersFrom removes filters and filter headers atomically", () => {
  const db = createSqliteDatabase(":memory:");
  db.filterHeaders.append([
    { height: 9, header: hexToBytes("09".repeat(32)) },
    { height: 10, header: hexToBytes("0a".repeat(32)) },
    { height: 11, header: hexToBytes("0b".repeat(32)) },
  ]);
  db.filters.append([
    {
      height: 10,
      blockHashInternalHex: "0a".repeat(32),
      filter: new Uint8Array([1]),
    },
    {
      height: 11,
      blockHashInternalHex: "0b".repeat(32),
      filter: new Uint8Array([2]),
    },
  ]);

  db.wipeFiltersFrom(10, { prevHeaderHeight: 9 });

  expect(db.filters.get(10)).toBeNull();
  expect(db.filters.get(11)).toBeNull();
  expect(db.filters.count()).toBe(0);
  expect(db.filterHeaders.get(9)).toBeNull();
  expect(db.filterHeaders.get(10)).toBeNull();
  expect(db.filterHeaders.tip()).toBeNull();
  db.close();
});
```

- [ ] **Step 2: Run test and verify RED**

```bash
bun test tests/unit/sqlite-filters.test.ts -t "wipeFiltersFrom"
```

Expected: FAIL because `wipeFiltersFrom` is missing.

### Task 2: Implement wipeFiltersFrom

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/sqlite-database.ts`
- Modify: `src/modules/filters-download.ts`

**Interfaces:**
- Produces: `Database.wipeFiltersFrom(height: number, options?: { prevHeaderHeight?: number }): void`

- [ ] **Step 1: Extend Database**

```typescript
wipeFiltersFrom(
  height: number,
  options?: { prevHeaderHeight?: number },
): void;
```

- [ ] **Step 2: Implement with inTx**

```typescript
wipeFiltersFrom(height, options) {
  inTx(() => {
    raw.query("DELETE FROM filters_unscanned WHERE height >= ?").run(height);
    raw.query("DELETE FROM filters WHERE height >= ?").run(height);
    raw.query("DELETE FROM filter_headers WHERE height >= ?").run(height);
    if (options?.prevHeaderHeight !== undefined) {
      raw
        .query("DELETE FROM filter_headers WHERE height = ?")
        .run(options.prevHeaderHeight);
    }
    filterCountCache = null;
    unscannedCountCache = null;
  });
}
```

Expose it on the returned `Database` object.

- [ ] **Step 3: Wire filters-download**

```typescript
function wipeFilterTablesFrom(height: number, rangeFrom: number): void {
  ctx.db.wipeFiltersFrom(
    height,
    height === rangeFrom && rangeFrom > 0
      ? { prevHeaderHeight: rangeFrom - 1 }
      : undefined,
  );
  hashCheckedThrough = Math.min(hashCheckedThrough, height - 1);
}
```

- [ ] **Step 4: Run focused tests GREEN**

```bash
bun test tests/unit/sqlite-filters.test.ts tests/unit/filters-download.test.ts
```

Expected: all pass.

### Task 3: Final verification

- [ ] **Step 1: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 2: Unit suite**

```bash
bun run test:unit
```

- [ ] **Step 3: Diff review**

```bash
git diff --check
git status --short
```
