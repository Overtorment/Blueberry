# Blueberry — BLOB payload storage

## Goal

Store wire/crypto **payloads** as SQLite `BLOB` instead of TEXT hex, cutting ~2× disk and removing hex encode/decode on hot read/write paths. Keep **identity hashes and txids** as TEXT hex so JS `Map` keys, PK lookups, and TUI display stay pass-through strings.

## Schema

| Table.column | Type |
|--------------|------|
| `headers.header` | `BLOB NOT NULL` |
| `filter_headers.header` | `BLOB NOT NULL` |
| `filters.filter` | `BLOB NOT NULL` |
| `blocks.block` | `BLOB NOT NULL` |
| `transactions.tx` | `BLOB NOT NULL` |

Unchanged (TEXT hex):

- `headers.hash_internal_hex` (+ index `headers_hash_internal_hex`)
- `filters.block_hash_internal_hex`
- `matched_blocks.block_hash_internal_hex`
- `blocks.block_hash_internal_hex`
- `transactions.block_hash_internal_hex`
- `transactions.txid` (PRIMARY KEY, display-order hex)

Fat-row discipline unchanged: never `UPDATE` filters/blocks rows to advance scan/parse progress (use `filters_unscanned` / `parsed_blocks`).

## TypeScript API

Binary at the repository boundary:

| Type | Field |
|------|--------|
| `HeaderRecord` | `header: Uint8Array` |
| `FilterHeaderRecord` | `header: Uint8Array` |
| `FilterRecord` | `filter: Uint8Array` |
| `DownloadedBlock` | `block: Uint8Array` |
| `StoredTx` / parse tx rows | `tx: Uint8Array` |

Hash / `txid` fields remain `string`.

`sqlite-database` binds and returns `Uint8Array` (or `Buffer`) for BLOB columns.

## Call-site pattern

- Persist/load raw bytes for payloads (no hex round-trip).
- Match scan passes `row.filter` into the matcher; identity hashes stay hex.
- Parse / balance: `Block.fromBuffer` / `Transaction.fromBuffer`.
- `bitcoin-headers` in-memory `HeaderRecord.headerHex` stays hex at the library boundary only.
