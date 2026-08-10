# Filter metadata covering index

## Goal

Reduce synchronous metadata scan time for the large `filters` table.

## Design

Add this index through `ensureSchema`:

```sql
CREATE INDEX IF NOT EXISTS filters_height_hash
  ON filters(height, block_hash_internal_hex);
```

SQLite can use the index for filter counts, height scans, and hash reconciliation.
The index avoids visits to table leaf pages that contain local BLOB payload data.

Do not change repository interfaces or split filter metadata into another table.

## Verification

Add a unit test that opens an in-memory SQLite database and calls `ensureSchema`.
The test must confirm that the index exists with the expected two columns.

Run the filter storage tests and TypeScript type checking.

## Live benchmark

Use the existing wallet database with user approval.

Measure these operations before and after index creation:

- `COUNT(*)` over `filters`
- Full-range filter/header hash reconciliation
- Full-range filter height aggregation

Record repeated timings, query plans, index build time, and index disk size.
Do not read wallet secrets or transaction payloads.
