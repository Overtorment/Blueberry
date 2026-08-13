# blueberry TUI hydrate / draw data path

Date: 2026-08-13  
Status: approved (conversation)

## Goal

Unify how tiles get numbers. Durable facts come from SQLite. Session facts come from bus payloads. The first React paint shows stored data at once. The user must not see `0/0` when the database already has headers, filters, blocks, or txs.

This revises:

- Message-bus scaffold: “TUI does not read storage” (2026-08-01)
- Peer discovery: TUI recounts peers on `peers:updated` (keep the read; make it the general durable rule)
- Block parsing: TUI reloads txs on `wallet:txs` (keep the read; stop treating progress payloads as a second source of the same counts)

## Decisions

| Topic | Choice |
|-------|--------|
| Durable facts | SQLite is the source. Bus event is a wake. TUI reads DB into stores |
| Session facts | Not in SQLite. Bus payload is the source. TUI applies the payload |
| First paint | TUI starts first, hydrates from DB, then React mounts, then domain modules start |
| Who reads DB for draw | Only `tui-module` (via `hydrate.ts`). React tiles never open SQLite |
| Fat snapshots on the bus | No. Do not put tx lists or UI row shapes on events |
| Persist last peer tip | No. Extra schema. First paint uses local header/filter span as `total` until a live `total > 0` arrives |
| Lying / zero payloads | Must not overwrite a DB hydrate. `total: 0` and `downloaded: 0` on progress events are ignored for those fields |
| `blocks:progress` → wallet list | No full snapshot. Refresh parse counts only (`setBlockCounts`). Txs stay on `wallet:txs` |
| Module start emits for durable data | Optional wakes. Not required for first paint |

## Architecture

```
boot
  create stores + tui-module
  tui.start()
    subscribe
    hydrateFromDb()          ← first numbers (ASAP)
    emit tui running
  mount React                ← first paint uses stores
  yield ~16ms
  start domain modules

durable wake (e.g. wallet:txs, matching:progress)
  tui-module → hydrate slice from SQLite → store
  ignore payload counts for that slice

session event (e.g. peers:sockets, broadcast:*)
  tui-module → store.apply(payload)
  no DB read
```

**Core pieces**

- `hydrate.ts` — all draw-time SQLite reads; fills existing stores
- `tui-module.ts` — subscribe + call hydrate / apply session payload
- Stores and React tiles — unchanged role (in-memory snapshot → hooks)

## Durable vs session

### Durable (TUI reads SQLite)

| Tile field | DB read |
|------------|---------|
| Peers `known` | `db.peers.count()` |
| Chain tip `height` | `db.headers.tip().height` |
| Chain tip `downloaded` | `max(0, tip.height - minHeight)` when both exist (same span as `chain-headers`) |
| Filters DL `downloaded` | `db.filters.count()`, clamped to session `total` when `total > 0` |
| Filters match `scanned` | `db.filters.countScanned()` |
| Filters match `total` | `db.filters.count()` |
| Blocks DL `downloaded` | `db.blocks.count()` |
| Blocks DL `matched` | `db.matchedBlocks.count()` |
| Balance, tx list, UTXOs, names, parse counts | `snapshotFromDb` |
| Receive address | `receiveAddressStore.refresh` |

### Session (TUI applies payload)

| Field | Event |
|-------|--------|
| Open sockets `probe` / `hdr` / `filt` / `blk` | `peers:sockets { kind, open }` |
| Chain tip `total` (peer tip span) | `headers:progress.total` only if `> 0` |
| Filters DL `total` (birthday-to-tip range) | `filters:progress.total` only if `> 0` |
| Broadcast phase / result | `broadcast:progress`, `broadcast:done` |
| Module status text | `module:status` |
| Parse ETA arming | `sync:idle` / `sync:catchup` (`setParsingActive`) |

ETA samples stay in TUI stores. They come from successive hydrates / session applies, not from SQLite.

Open sockets start at 0. That is true at launch.

## Mixed tiles

**Chain tip.** Hydrate sets `downloaded` and `height` from headers. If no live peer `total` yet, set `total = downloaded` so the tile is not `0/0`. The bar may show 100% until a peer tip arrives. Then `headers:progress` with `total > 0` updates `total` only. Payload `total: 0` leaves the store as-is for `total`.

**Filters DL.** Same pattern: hydrate `downloaded` from row count; `total = downloaded` until `filters:progress.total > 0`. Birthday-pending `0/0` from the module does not wipe the seed.

Do not persist last peer tip.

## Hydrate API

Add `src/tui/hydrate.ts`. Export these functions:

```ts
hydrateFromDb(db, stores, wallet?): void

hydratePeers(db, peerSocketsStore): void
hydrateHeaders(db, headersProgressStore, peerTotal?: number): void
hydrateFilters(db, filtersProgressStore, rangeTotal?: number): void
hydrateMatching(db, matchingProgressStore): void
hydrateBlocks(db, blocksMatchedStore): void
hydrateWallet(db, walletTxsStore, receiveAddressStore?, wallet?, at: number): void
```

`hydrateHeaders` / `hydrateFilters`: if the optional total is missing or `<= 0`, use the durable downloaded count as `total`.

`tui.start()` order:

1. Register all bus handlers
2. `hydrateFromDb()` once
3. Emit `module:status` starting then running

Boot order in `main.tsx` stays: start tui → mount React → yield → start domain modules. Document this as required, not incidental.

## Event handling in `tui-module`

| Event | TUI action |
|-------|------------|
| `peers:updated` | `hydratePeers` |
| `peers:sockets` | `peerSocketsStore.applyEvent` |
| `headers:progress` | `hydrateHeaders(db, store, p.total)` |
| `filters:progress` | `hydrateFilters(db, store, p.total)` |
| `matching:progress` | `hydrateMatching` (ignore payload counts) |
| `blocks:progress` | `hydrateBlocks` + `hydrateWalletBlockCounts` (counts only, not txs) |
| `filters:match` | `hydrateBlocks` (remove `setMatched`) |
| `wallet:txs` | `hydrateWallet` |
| `sync:idle` | `walletTxsStore.setParsingActive(true)` |
| `sync:catchup` | `walletTxsStore.setParsingActive(false)` |
| `module:status` | status store |
| `broadcast:progress` / `broadcast:done` | broadcast store |

Event payload types may keep existing count fields so producers stay simple. TUI must not use those counts when the field is durable.

Update comments in `src/bus/types.ts` to match this split. Durable events are wakes. Session events document which fields the TUI applies.

## What we stop doing

- Applying durable counts from a progress payload **and** also reading the same counts from DB
- Domain modules skipping a start emit only to protect a TUI seed (`chain-headers` “do not emit `total: 0`” is no longer a TUI invariant; TUI ignores `total: 0`)
- Putting wallet rows on `wallet:txs`
- Waiting on domain `start()` to draw stored data
- Rebuilding the wallet snapshot on every `blocks:progress`

`parse-blocks` still emits `wallet:txs { at }` after parse work. That remains a wake. First paint does not need that emit; hydrate already loaded txs.

Module start emits (`blocks-download` `emitProgress(true)`, `filters-matching` `seedProgress`) may stay as wakes. They are not the first-paint path.

## Files

| File | Role |
|------|------|
| `src/tui/hydrate.ts` | Create: SQLite → stores |
| `src/tui/tui-module.ts` | Wire bus to hydrate / session apply; delete inline seed reads |
| `src/bus/types.ts` | Comments: durable wake vs session payload |
| `src/tui/blocks-matched-store.ts` | Keep `applyEvent`. Remove `setMatched` (TUI hydrates both counts from DB) |
| Tests under `tests/unit/tui-*.test.ts` | Hydrate ASAP; zero payload must not clobber; durable events follow DB |

No schema change. No new bus event names required.

## Tests

- Filled DB, `tui.start()`, no domain module started → headers / filters / matching / blocks / peers known / wallet stores are not `0/0` / empty when rows exist
- After hydrate, emit `headers:progress` or `filters:progress` with `downloaded: 0, total: 0` → stores keep hydrated values
- `matching:progress` / `blocks:progress` with counts that do not match DB → stores follow DB
- `headers:progress` with `total > 0` → `total` updates; `height` / `downloaded` still from DB
- `wallet:txs` still refreshes txs/balance from DB
- `blocks:progress` updates the Blocks tile from DB, updates wallet parse counts, and does **not** replace the tx list

Adapt existing tests that assume payload numbers win (`tui-headers-progress`, `tui-matching-progress`, `tui-blocks-matched`, `tui-wallet-txs` `blocks:progress` → `blocksTotal`).

## Out of scope

- Onboarding (secret / year) — runs before modules
- `send-context` and `utxo-names-actions` write/read DB for actions, not for tile paint
- Changing progress bar layout or ETA math
- Persisting peer tip or moving socket counts into SQLite
- New modules or new event names

## Error handling

Hydrate uses the same DB APIs as today. Missing tip / empty tables → stores stay at zero. That is a true empty wallet, not a race with domain start.

Thrown DB errors in handlers are not a new policy: existing bus `emit` swallows handler throws. Do not add retry in hydrate.
