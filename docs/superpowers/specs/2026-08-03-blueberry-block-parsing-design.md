# blueberry block parsing design

Date: 2026-08-03  
Status: approved (conversation)  
Amended: 2026-08-03 — watch index persistence + gap growth; rematch from first used height (not top 1440)

## Goal

Implement the `parse-blocks` module: decode downloaded matched blocks, find wallet-relevant transactions, persist them, and drive Balance + Transactions TUI from storage. Never parse the same block twice. Correct balance even if blocks are parsed out of height order. On init, emit so the TUI can render any already-stored data (resume / stale process).

Grow the external/internal watch ranges when used addresses approach the end of the current scan window; persist those ranges in SQLite; when a range grows, rematch filters from the earliest known wallet tx height so newly watched scripts (and later spends) can hit.

## Decisions

| Topic | Choice |
|-------|--------|
| Tx storage model | Persist wallet-relevant txs; Balance recomputes UTXOs from the tx list (no separate utxos table) |
| Wake signal | Reuse `blocks:progress`; ignore while a parse run is in progress (`busy` / `needsRun`) |
| TUI refresh event | Single `wallet:txs { at }` for init and after **each** parsed block |
| Parsed tracking | Separate `parsed_blocks` table (do not `UPDATE blocks` — avoids rewriting fat `block_hex`) |
| Decode API | `Block.fromHex` from bitcoinjs-lib |
| Watch addresses | Derive from DB-stored external/internal scan counts (not a fixed single gap) |
| Watch index storage | Generic `key_value` table; keys `watch_external` / `watch_internal` |
| Gap constants | `GAP_LIMIT = 20`; initial scan count per chain = `2 * GAP_LIMIT` (= 40); keep `ADDRESS_GAP` as that initial default/alias |
| Gap ownership | `parse-blocks` runs the growth check; both `parse-blocks` and `filters-matching` read indexes from DB |
| Rematch on growth | Unscanned = all `filters` with height ≥ min stored wallet tx height; wake matching via synthetic `filters:progress` |
| Balance module | None — Balance and Transactions tiles read storage on `wallet:txs` |
| Display | Balance: sats + BTC. Transactions: height, short txid, net Δ (newest first) |

## Architecture

```
blocks-download → blocks:progress
                      ↓
              parse-blocks (busy / needsRun)
                      ↓
         Block.fromHex → filter by watch scripts
                      ↓
         SQLite: transactions + parsed_blocks
                      ↓
         gap check → maybe grow key_value indexes
                      ↓
         (on grow) markUnscannedFrom(first used height) + filters:progress
                      ↓
                 wallet:txs { at }
                      ↓
        TUI Balance + Transactions (reload DB)

filters-matching ← filters:progress (download or synthetic)
        reads watch_external / watch_internal from key_value
        re-derives scripts when counts change
```

### Lifecycle

1. **start:** emit `module:status` starting → ensure watch indexes in `key_value` → derive watch wallet from DB counts → run parse backlog (gap check after each parsed block; also once if backlog empty) → emit `wallet:txs` if needed → subscribe to `blocks:progress` → emit running.
2. **steady:** idle until kick; if busy when `blocks:progress` arrives, set `needsRun` and return; after a run, if `needsRun`, run again. After each successfully parsed block, run the gap check (may grow indexes and kick matching).
3. **stop:** unsubscribe, wake idle waiters, await in-flight loop, emit stopped.

Parse backlog = rows in `blocks` whose height is not in `parsed_blocks`. Prefer lowest height first for efficiency; correctness does not require ordered parse.

## Storage

### `parsed_blocks`

| Column | Type | Notes |
|--------|------|-------|
| `height` | INTEGER PK | Presence means never parse again |

### `transactions`

One row per wallet-relevant transaction.

| Column | Type | Notes |
|--------|------|-------|
| `txid` | TEXT PK | Display-order hex |
| `height` | INTEGER | Block height |
| `tx_index` | INTEGER | Position in block |
| `block_hash_internal_hex` | TEXT | Block identity |
| `hex` | TEXT | Full transaction hex |
| `net_delta_sats` | INTEGER | Cached our receive − our spend; refreshed after parse by an ordered recompute |

### `key_value`

Arbitrary string map for small persisted settings.

| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT PK | e.g. `watch_external`, `watch_internal` |
| `value` | TEXT | Stringified scan count (decimal integer) |

Defaults when missing: both chains `2 * GAP_LIMIT` (40). First ensure/read may write the defaults.

### Repository API (additions)

- `blocks.listNeedingParse(limit): DownloadedBlock[]` — downloaded heights missing from `parsed_blocks`, lowest height first
- `parsedBlocks.mark(height): void` (idempotent insert)
- `parsedBlocks.has(height): boolean` (tests / optional)
- `transactions.upsert(tx): void`
- `transactions.list(): StoredTx[]` — ordered by `height DESC`, `tx_index DESC` for UI
- `keyValue.get(key): string | null`
- `keyValue.set(key, value): void`
- `filters.markUnscanned(heights: number[]): void` — re-insert heights into `filters_unscanned` (never UPDATE fat `filters` rows)
- Expose `parsedBlocks`, `transactions`, and `keyValue` on `Database`

Mark a height parsed only after successful decode + relevant-tx writes for that block. Decode/write failure leaves the height unparsed for retry. Always mark parsed when decode succeeds even if zero wallet txs (filter false positives).

## Parse rules

1. `Block.fromHex(block.blockHex)`.
2. Watch set = hex(scriptPubKey) for each address from `deriveWatchWallet` using DB external/internal counts.
3. A tx is relevant if any of:
   - an output `scriptPubKey` is in the watch set, or
   - a non-coinbase input spends a known watch UTXO (prevout `txid:vout` from stored watch txs or earlier in this block), or
   - a non-coinbase input resolves to a watched script without prior UTXO knowledge (for our P2WPKH watchlist: witness pubkey → `p2wpkh` scriptPubKey ∈ watch set). This covers spend-before-receive parse order.
4. Persist relevant txs (full `hex` is source of truth). Then `parsedBlocks.mark(height)`.
5. After each successfully parsed block, emit `wallet:txs` so the TUI updates (`blocksParsed` / txs). When that block wrote any txs, recompute `net_delta_sats` first (ordered walk); otherwise a bare emit is enough for the parse counter.
6. After each successfully parsed block, run the gap-growth check (below). On init with an empty parse backlog, still run the check once so existing stored txs can grow indexes. Also recompute deltas at batch end as a safety net.

### Out-of-order safety

- Relevance must not depend solely on already-stored UTXOs (see P2WPKH witness rule above).
- `balanceFromTxs(txs)` always sorts by `(height ASC, tx_index ASC)` before applying creates/spends.
- Cached `net_delta_sats` is recomputed from full tx hex after batches; UI may also derive deltas via the same helper.

## Watch indexes & gap growth

### Constants

- `GAP_LIMIT = 20`
- Initial per-chain scan count = `2 * GAP_LIMIT` (= 40). `ADDRESS_GAP` remains that initial value for compatibility.
### Derive API

```ts
deriveWatchWallet(mnemonic, gaps: { external: number; internal: number })
```

Filters-matching and parse-blocks both load counts from `key_value` and derive independently. A single-number `addressGap` overload may remain as `deriveWatchWallet(mnemonic, n)` ≡ `{ external: n, internal: n }` for tests. At runtime, DB indexes are source of truth; modules should not keep a constructor gap that ignores `key_value`.

### Used-index detection

Pure helper:

```ts
usedWatchIndexes(txs, wallet) → { external: number[]; internal: number[] }
```

- A watch address counts as used if any stored tx pays its script or spends it (same signals as parse relevance: watch output, known watch outpoint, or P2WPKH witness → watch script).
- Only indices within the current scan window are considered for the danger-zone check.

### Growth algorithm (`parse-blocks`)

Run after each successfully parsed block, and once on module startup when the parse backlog is empty (so existing stored txs are still checked).

For each chain with scan count `N`:

1. If any used index is in `[N - GAP_LIMIT, N)`, set `N := N + GAP_LIMIT` and persist (one bump per check; used indexes come from the current window, so one bump clears the danger zone for that chain).

If either chain grew:

1. Re-derive the in-memory watch wallet from the new counts.
2. Let `fromHeight =` minimum height among stored wallet `transactions`. If the table is non-empty, `markUnscannedFrom(fromHeight)` — re-queue every filter with `height >= fromHeight` (one SQL insert-select; does not clear `matched_blocks` / `blocks` / `parsed_blocks`).
3. Emit synthetic `filters:progress` to reuse filters-matching’s kick path:
   - `downloaded = filters.count()`
   - `total =` header sync range size when headers exist (`tip - minHeight + 1`, same notion as filters-download); otherwise `total = downloaded`
   - `at = Date.now()` (or injected `now`)
   - sync-idle only uses this event as a wake (payload ignored); TUI may briefly refresh the Filters tile from these truthful counts.

### filters-matching

- On each scan loop iteration, read `watch_external` / `watch_internal` and re-derive when either count differs from the in-memory wallet.
- Kick path unchanged: `filters:progress` (including synthetic emits from parse-blocks).

### Intentional limits

- Rematch starts at the earliest known wallet activity, not the genesis of the filter DB. Filters below that height stay scanned.
- Already-parsed older blocks are not re-parsed for newly watched addresses in this pass; new hits arrive via rematch → blocks-download → parse.

## Pure helpers

Live under `src/parse/` (and wallet/derive as needed) with unit tests:

- `extractWatchTxs(block, watchScripts, priorWatchUtxos)` → relevant txs (hex, txid, index, …)
- `recomputeNetDeltas(txs)` / `balanceFromTxs(txs)` → ordered UTXO unwrap → per-tx net Δ and `{ sats, utxoCount }`
- `usedWatchIndexes` + growth helper (bump counts when danger zone is hot)
- Small format helpers: short txid, sats/BTC strings for the TUI

## Bus

Add to `EventMap`:

```ts
"wallet:txs": { at: number };
```

No new download event. No `wallet:balance` event in this pass. Gap growth reuses `filters:progress` (synthetic) — no new matching event.

## TUI

- Small `wallet-txs` store + `useWalletTxs` hook (same external-store pattern as blocks-matched).
- On `wallet:txs`: reload `db.transactions.list()`.
- **Balance:** `balanceFromTxs` → show BTC and sats (e.g. `0.01234567 BTC` / `1234567 sats`). Magenta panel; active when non-zero or module not idle.
- **Transactions:** rows `height  shortTxid  +/−Δ`, newest first. Cyan panel; active when list non-empty or parse-blocks not idle.
- `tui-module` wires the bus handler and seeds from DB if needed after mount (same spirit as matching progress re-seed).

## Error handling

- Per-block decode/persist errors: emit `module:status` with `status: "error"` and a short `detail`; do not mark that height parsed; keep the module loop running so later kicks/retries can succeed.
- Bus handler isolation unchanged.

## Testing

- Helper: receive hit, spend of our UTXO, ignore unrelated, spend-before-receive insert order still balances and records both txs.
- DB: `listNeedingParse`, mark parsed, second parse skipped; `key_value` get/set; `markUnscanned` re-queues heights.
- Gap: used address in last `GAP_LIMIT` of window bumps count by `GAP_LIMIT`; both chains independent; startup check grows if needed; growth emits `filters:progress` and leaves filters from first used height unscanned.
- Module: backlog on start; `blocks:progress` while busy sets `needsRun` only; emits `wallet:txs` on init.
- Matching: after synthetic progress + higher indexes, scans with expanded scripts.
- TUI store / formatting smoke as with other panels.

## Success criteria

1. Downloaded matched blocks are parsed at most once and marked in `parsed_blocks`.
2. Wallet-relevant txs appear in `transactions` with correct `net_delta_sats`.
3. Out-of-order parse still yields the correct confirmed balance.
4. Balance and Transactions update on `wallet:txs`, including after restart with existing DB data.
5. External/internal scan counts persist in `key_value` and default to 40.
6. Danger-zone usage grows the relevant chain by `GAP_LIMIT`, rematches filters from the earliest wallet tx height, and kicks filters-matching via `filters:progress`.
7. `bun test` and `bun run typecheck` pass.

## Out of scope

- Separate Balance domain module
- Mempool / unconfirmed txs
- Rematch / re-parse below the earliest known wallet tx height
- Fee display, sending, coin selection
- Changing blocks-download emit shape
