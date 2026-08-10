# Atomic filter wipe

## Goal

Delete compact-filter rows and filter-header rows in one SQLite transaction. Avoid a crash window where filters are gone but stale filter headers remain.

## API

Add on `Database`:

```ts
wipeFiltersFrom(
  height: number,
  options?: { prevHeaderHeight?: number },
): void
```

In one transaction:

1. `DELETE FROM filters_unscanned WHERE height >= ?`
2. `DELETE FROM filters WHERE height >= ?`
3. `DELETE FROM filter_headers WHERE height >= ?`
4. If `options.prevHeaderHeight` is set:  
   `DELETE FROM filter_headers WHERE height = ?`

Clear in-memory filter count caches after a successful wipe.

Do not delete matched blocks, full blocks, parsed markers, transactions, or headers.

## Call site

In `filters-download` `wipeFilterTablesFrom`:

```ts
ctx.db.wipeFiltersFrom(
  height,
  height === rangeFrom && rangeFrom > 0
    ? { prevHeaderHeight: rangeFrom - 1 }
    : undefined,
);
```

Keep `filters.deleteFrom` and `filterHeaders.deleteFrom` for existing unit tests and narrow callers.

## Verification

- Unit test seeds filters and filter headers, calls `wipeFiltersFrom` with optional prev header, asserts both tables match the expected remaining tip
- Existing filter unit tests stay green
- Typecheck and unit suite pass
