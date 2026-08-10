# Peer Services INTEGER Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store peer `nServices` as signed SQLite INTEGER bit patterns with exact unsigned 64-bit round-trips.

**Architecture:** Export tiny conversion helpers. Change the peers table declaration to INTEGER. Open Bun SQLite with `{ safeIntegers: true }` and coerce other INTEGER columns to `number` in mappers. Migrate existing TEXT columns by rebuilding the table once inside `ensureSchema`. Bind and filter with signed bigint masks.

**Tech Stack:** TypeScript, Bun, `bun:sqlite`, SQLite

## Global Constraints

- Do not read wallet secrets or transaction payloads.
- Do not change repository interfaces in `src/db/types.ts`.
- Do not add boolean service-flag columns.
- Do not commit changes unless the user requests a commit.
- Migrate the approved live database by opening `createSqliteDatabase`.

---

### Task 1: Conversion helpers and failing tests

**Files:**
- Create: `src/db/peer-services.ts`
- Modify: `tests/unit/sqlite-peers.test.ts`

**Interfaces:**
- Consumes: unsigned `bigint` service bitfields from the network layer.
- Produces:
  - `toSqliteServices(services: bigint): bigint`
  - `fromSqliteServices(stored: bigint | number | string): bigint`

- [ ] **Step 1: Write failing helper and peer tests**

Create `src/db/peer-services.ts` with stub exports that throw, or omit the file and import it from the test so the import fails. Prefer real signatures with wrong behavior only if needed for compile; prefer missing implementation.

Add tests to `tests/unit/sqlite-peers.test.ts`:

```typescript
import {
  fromSqliteServices,
  toSqliteServices,
} from "../../src/db/peer-services.ts";

test("services helpers round-trip full unsigned 64-bit range", () => {
  const high = 1n << 63n;
  const max = (1n << 64n) - 1n;
  expect(fromSqliteServices(toSqliteServices(0n))).toBe(0n);
  expect(fromSqliteServices(toSqliteServices(2049n))).toBe(2049n);
  expect(fromSqliteServices(toSqliteServices(high))).toBe(high);
  expect(fromSqliteServices(toSqliteServices(max))).toBe(max);
  expect(toSqliteServices(high)).toBe(-(1n << 63n));
});

test("high service bit survives upsert and service filters", () => {
  const db = createSqliteDatabase(":memory:");
  const high = 1n << 63n;
  db.peers.upsert(
    basePeer({ host: "9.9.9.9", services: high | 64n, alive: true }),
  );
  expect(db.peers.list()[0]?.services).toBe(high | 64n);
  expect(
    db.peers.listAliveWithServices(high, 10).map((p) => p.host),
  ).toEqual(["9.9.9.9"]);
  expect(
    db.peers.listWithServices(64n, 10).map((p) => p.host),
  ).toContain("9.9.9.9");
  db.close();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test tests/unit/sqlite-peers.test.ts
```

Expected: FAIL on missing module or wrong round-trip / filter behavior.

- [ ] **Step 3: Implement helpers**

Create `src/db/peer-services.ts`:

```typescript
const U64 = 1n << 64n;
const I64_MAX = (1n << 63n) - 1n;

export function toSqliteServices(services: bigint): bigint {
  const v = services & (U64 - 1n);
  return v > I64_MAX ? v - U64 : v;
}

export function fromSqliteServices(
  stored: bigint | number | string,
): bigint {
  const v = typeof stored === "bigint" ? stored : BigInt(stored);
  return v < 0n ? v + U64 : v;
}
```

- [ ] **Step 4: Re-run helper test**

Run:

```bash
bun test tests/unit/sqlite-peers.test.ts -t "services helpers"
```

Expected: helper test PASS; high-bit DB test still FAIL until schema/write path changes.

### Task 2: Schema, migration, and repository wiring

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/sqlite-database.ts`

**Interfaces:**
- Consumes: `toSqliteServices`, `fromSqliteServices`.
- Produces: INTEGER `peers.services` on new and migrated databases.

- [ ] **Step 1: Change CREATE TABLE and migrate TEXT peers**

In `src/db/schema.ts`:

1. Change the peers column to:

```sql
services INTEGER NOT NULL DEFAULT 0,
```

2. After creating tables/indexes, detect TEXT affinity:

```typescript
const servicesType = raw
  .query(
    `SELECT type AS t FROM pragma_table_info('peers')
     WHERE name = 'services'`,
  )
  .get() as { t: string } | null;
```

3. If `servicesType?.t` equals `TEXT` (case-insensitive), rebuild:

```sql
CREATE TABLE peers_new (
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  services INTEGER NOT NULL DEFAULT 0,
  alive INTEGER NOT NULL DEFAULT 0,
  used_for_blocks INTEGER NOT NULL DEFAULT 0,
  last_probed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (host, port)
);
```

Read old rows with `SELECT * FROM peers`. Insert into `peers_new` using `toSqliteServices(fromSqliteServices(row.services))` so decimal TEXT above `2^63-1` converts through JS bigint. Then:

```sql
DROP TABLE peers;
ALTER TABLE peers_new RENAME TO peers;
CREATE INDEX IF NOT EXISTS peers_alive_used
  ON peers(alive, used_for_blocks);
```

Wrap the rebuild in `BEGIN` / `COMMIT` with `ROLLBACK` on failure.

- [ ] **Step 2: Wire sqlite-database reads and writes**

In `src/db/sqlite-database.ts`:

1. Change `PeerRow.services` to `bigint | number | string`.
2. In `rowToPeer`, use `fromSqliteServices(row.services)`.
3. In `upsert`, bind `toSqliteServices(peer.services)` instead of `peer.services.toString()`.
4. In `listAliveWithServices` and `listWithServices`, bind `toSqliteServices(serviceBits)` and replace predicates with `(services & ?) != 0` (no `CAST`).

- [ ] **Step 3: Run peer tests and verify GREEN**

Run:

```bash
bun test tests/unit/sqlite-peers.test.ts
```

Expected: all peer tests PASS.

### Task 3: Live migration and verification

**Files:**
- Modify through open: `blueberry.data/blueberry.sqlite`

**Interfaces:**
- Consumes: `createSqliteDatabase(path: string): Database`.
- Produces: migrated live peers table and verification evidence.

- [ ] **Step 1: Open the live database once**

Run:

```bash
/usr/bin/time -f 'migrate: %e s' bun -e \
  'import { createSqliteDatabase } from "./src/db/sqlite-database.ts";
   const db = createSqliteDatabase("./blueberry.data/blueberry.sqlite");
   console.log("peers", db.peers.count());
   console.log("sample", db.peers.listAliveWithServices(64n, 3).map(p => p.services.toString()));
   db.close();'
```

Expected: exit code 0.

- [ ] **Step 2: Confirm INTEGER storage**

Run:

```sql
SELECT typeof(services) AS t, COUNT(*) FROM peers GROUP BY 1;
SELECT type FROM pragma_table_info('peers') WHERE name='services';
PRAGMA quick_check;
```

Expected: only `integer` values; declared type `INTEGER`; quick_check `ok`.

- [ ] **Step 3: Confirm high-bit rows survived**

Count peers whose unsigned services still have bit 63 set after migration by scanning through the repository API or a JS open. Do not print host lists larger than a small sample. Expected: the previous 166 over-range TEXT values remain exact as unsigned values `>= 2^63`.

### Task 4: Final verification

**Files:**
- Verify: `src/db/peer-services.ts`, `src/db/schema.ts`, `src/db/sqlite-database.ts`, `tests/unit/sqlite-peers.test.ts`

**Interfaces:**
- Consumes: completed INTEGER services change.
- Produces: test and type-check evidence.

- [ ] **Step 1: Run focused tests**

```bash
bun test tests/unit/sqlite-peers.test.ts tests/unit/sqlite-filters.test.ts
```

Expected: all pass.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Review diff**

```bash
git diff --check
git status --short
```

Expected: only peer-services INTEGER work plus any already-approved uncommitted filter-index files.
