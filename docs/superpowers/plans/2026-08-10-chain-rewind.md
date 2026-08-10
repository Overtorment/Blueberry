# Chain Rewind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On header reorg, atomically delete all height-dependent chain data above the common ancestor.

**Architecture:** Add `Database.rewindAfter` and `Database.transaction`. Replace mode in `persistBranch` runs rewind then `headers.replaceAfter` inside one transaction. Nested repository transactions join an open transaction instead of issuing a second `BEGIN`.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`

## Global Constraints

- Do not change gap-growth rematch behavior.
- Do not touch `peers`, `key_value`, or `utxo_names` in rewind.
- Do not commit unless the user asks.
- Prefer TDD: failing test first.

---

### Task 1: Failing rewind test

**Files:**
- Create or modify: `tests/unit/sqlite-rewind.test.ts`

**Interfaces:**
- Consumes: `createSqliteDatabase`, future `db.rewindAfter`, `db.headers.replaceAfter`.
- Produces: RED test proving stale chain data survives today without rewind wiring, then GREEN after implementation.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sqlite-rewind.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { hexToBytes } from "bitcoin-headers";
import { checkpointDbRecord, checkpointSeedRecord } from "../../src/checkpoint.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

function hdr(height: number, suffix: string, cumulativeWork: bigint) {
  return {
    height,
    hashInternalHex: "i".repeat(64 - suffix.length) + suffix,
    header: new Uint8Array(80).fill(0xab),
    cumulativeWork,
  };
}

describe("SqliteDatabase chain rewind", () => {
  test("rewindAfter drops height-dependent rows above ancestor", () => {
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    const base = db.headers.tip()!.cumulativeWork;
    const h1 = seed.height + 1;
    const h2 = seed.height + 2;
    db.headers.append([
      hdr(h1, "a1", base + 1n),
      hdr(h2, "a2", base + 2n),
    ]);

    db.filterHeaders.append([
      { height: h1, header: hexToBytes("11".repeat(32)) },
      { height: h2, header: hexToBytes("22".repeat(32)) },
    ]);
    db.filters.append([
      {
        height: h1,
        blockHashInternalHex: "11".repeat(32),
        filter: new Uint8Array([1]),
      },
      {
        height: h2,
        blockHashInternalHex: "22".repeat(32),
        filter: new Uint8Array([2]),
      },
    ]);
    db.matchedBlocks.insert({
      height: h2,
      blockHashInternalHex: "22".repeat(32),
    });
    db.blocks.insert({
      height: h2,
      blockHashInternalHex: "22".repeat(32),
      block: new Uint8Array([9]),
    });
    db.parsedBlocks.mark(h2);
    db.transactions.upsert({
      txid: "aa".repeat(32),
      height: h2,
      txIndex: 0,
      blockHashInternalHex: "22".repeat(32),
      tx: new Uint8Array([7]),
      netDeltaSats: 1,
    });

    db.transaction(() => {
      db.rewindAfter(h1);
      db.headers.replaceAfter(h1, [hdr(h2, "b2", base + 20n)]);
    });

    expect(db.headers.tip()?.hashInternalHex.endsWith("b2")).toBe(true);
    expect(db.filterHeaders.get(h2)).toBeNull();
    expect(db.filters.get(h2)).toBeNull();
    expect(db.filters.get(h1)).not.toBeNull();
    expect(db.matchedBlocks.count()).toBe(0);
    expect(db.blocks.has(h2)).toBe(false);
    expect(db.parsedBlocks.has(h2)).toBe(false);
    expect(db.transactions.list()).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test and verify RED**

```bash
bun test tests/unit/sqlite-rewind.test.ts
```

Expected: FAIL because `transaction` / `rewindAfter` are missing.

### Task 2: Database transaction + rewindAfter

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/sqlite-database.ts`

**Interfaces:**
- Produces:
  - `Database.transaction(fn: () => void): void`
  - `Database.rewindAfter(ancestorHeight: number): void`

- [ ] **Step 1: Extend the Database interface**

In `src/db/types.ts` on `Database`:

```typescript
  /** Run fn in one SQLite transaction (nested calls join / savepoint). */
  transaction(fn: () => void): void;
  /** Delete height-dependent chain rows with height > ancestorHeight. */
  rewindAfter(ancestorHeight: number): void;
  close(): void;
```

- [ ] **Step 2: Add an in-transaction helper**

Near the top of `createSqliteDatabase` body:

```typescript
function inTx(fn: () => void): void {
  if (raw.inTransaction) {
    fn();
    return;
  }
  raw.transaction(fn)();
}
```

Change existing `BEGIN`/`COMMIT`/`ROLLBACK` blocks in this file that wrap repository writes to use `inTx(fn)` instead, at least for `headers.replaceAfter` and `headers.append`. Prefer converting all local `BEGIN` blocks in this file to `inTx` so nesting is safe.

- [ ] **Step 3: Implement rewindAfter**

```typescript
rewindAfter(ancestorHeight: number): void {
  inTx(() => {
    raw.query("DELETE FROM filter_headers WHERE height > ?").run(ancestorHeight);
    raw.query("DELETE FROM filters_unscanned WHERE height > ?").run(ancestorHeight);
    raw.query("DELETE FROM filters WHERE height > ?").run(ancestorHeight);
    raw.query("DELETE FROM matched_blocks WHERE height > ?").run(ancestorHeight);
    raw.query("DELETE FROM blocks WHERE height > ?").run(ancestorHeight);
    raw.query("DELETE FROM parsed_blocks WHERE height > ?").run(ancestorHeight);
    raw.query("DELETE FROM transactions WHERE height > ?").run(ancestorHeight);
    filterCountCache = null;
    unscannedCountCache = null;
  });
}
```

Expose:

```typescript
transaction(fn) {
  inTx(fn);
},
rewindAfter(ancestorHeight) { /* above */ },
```

Note: `filterCountCache` lives later in the function. Declare cache variables before `rewindAfter`, or define `rewindAfter` after the cache declarations and attach it on the returned object.

- [ ] **Step 4: Run rewind test GREEN**

```bash
bun test tests/unit/sqlite-rewind.test.ts
```

Expected: PASS.

### Task 3: Wire replace mode in chain-headers

**Files:**
- Modify: `src/modules/chain-headers.ts`
- Modify: `tests/unit/chain-headers.test.ts` (extend reorg test or add assertion)

**Interfaces:**
- Consumes: `ctx.db.transaction`, `ctx.db.rewindAfter`, `ctx.db.headers.replaceAfter`.

- [ ] **Step 1: Update persistBranch**

```typescript
function persistBranch(
  ctx: ModuleContext,
  branch: ValidatedHeaderBranch,
  mode: "append" | "replace",
  ancestorHeight: number,
): void {
  const writes: HeaderWrite[] = branch.headers.map((record) => ({
    height: record.height,
    hashInternalHex: record.hashInternalHex,
    header: hexToBytes(record.headerHex),
    cumulativeWork: branch.cumulativeWorkByHeight.get(record.height)!,
  }));
  if (mode === "append") {
    ctx.db.headers.append(writes);
    return;
  }
  ctx.db.transaction(() => {
    ctx.db.rewindAfter(ancestorHeight);
    ctx.db.headers.replaceAfter(ancestorHeight, writes);
  });
}
```

- [ ] **Step 2: Extend the existing reorg unit test**

In `tests/unit/chain-headers.test.ts` inside `"reorgs to a heavier fork via the sync loop"` (or a sibling test), seed a matched block / tx on the old tip height before the reorg completes, then assert they are removed after the heavier fork applies.

Keep the test focused: one matched block row and one transaction at the old tip is enough.

- [ ] **Step 3: Run tests**

```bash
bun test tests/unit/sqlite-rewind.test.ts tests/unit/chain-headers.test.ts tests/unit/sqlite-headers.test.ts
```

Expected: all pass.

### Task 4: Final verification

**Files:**
- Verify changed sources and tests

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
