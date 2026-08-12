# Atomic chain rewind on reorg

## Goal

When headers move to a heavier fork, delete all height-dependent chain data above the common ancestor in the same transaction as the header replace. Prevent stale matched blocks, full blocks, and wallet transactions from surviving a reorg.

## API

Add:

```ts
interface Database {
  rewindAfter(ancestorHeight: number): void;
  // existing...
}
```

`rewindAfter(ancestorHeight)` deletes rows with `height > ancestorHeight` from:

- `filter_headers`
- `filters`
- `filters_unscanned`
- `matched_blocks`
- `blocks`
- `parsed_blocks`
- `transactions`

It does not modify:

- `headers` (caller uses `headers.replaceAfter`)
- `peers`
- `key_value`
- `utxo_names`

After deleting filters, clear in-memory filter count caches.

## Call site

In `persistBranch` replace mode:

1. Begin one SQLite transaction
2. Call `db.rewindAfter(ancestorHeight)`
3. Call `db.headers.replaceAfter(ancestorHeight, writes)`
4. Commit

Append mode stays unchanged.

Add a small `Database.transaction(fn: () => void): void` helper if needed so replace mode can wrap both steps. Nested repository `BEGIN` calls must not break this (use savepoints, or make `replaceAfter` / `rewindAfter` join an open transaction).

## Out of scope

- Gap-growth rematch (`markUnscannedFrom` + `parsedBlocks.clearFrom`) still keeps downloaded blocks
- No runtime schema migration
- No peer pruning

## Verification

- Unit test seeds headers, filter data, matched block, block, parsed marker, and wallet tx above an ancestor
- Call rewind + header replace (or the persist replace path)
- Assert dependent rows above the ancestor are gone
- Assert ancestor and new headers remain
- Existing header replace and chain-headers reorg tests stay green
