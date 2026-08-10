# blueberry filters matching — prior port design

Date: 2026-08-02  
Status: approved (conversation)

## Goal

Throw away the current filters-matching implementation (including the BIP-158 Worker) and reimplement matching by porting the prior project's  scan algorithm. Keep only the app-facing interface: module lifecycle, bus events, and how `main` / TUI / blocks-download consume progress and matches.

## Decisions

| Topic | Choice |
|-------|--------|
| Approach | Thin module shell + ported scan helper (Approach 1) |
| Watchlist model | Full BIP84 watchlist × each filter (prior scanner); **drop** address-gap cursors |
| Scanned persistence | Single `scanned` INTEGER flag on each `filters` row |
| Migration of existing DBs | **Reset**: all filters become unscanned (`scanned = 0`) |
| BIP-158 execution | Sync `matchAnyBasicFilters` on the main thread + yield to event loop (no Worker) |
| Progress bus shape | Unchanged: `matching:progress { at, matched, total }` where `matched` means **scanned count** |
| Match bus shape | Unchanged: `filters:match { height, blockHashInternalHex }` |
| Kick | Unchanged: listen `filters:progress`; busy dirty-bit; idle wake |
| Storage access | Behind `Database` / repository interfaces only |
| Inter-module communication | Bus only |

## Architecture

```
main
├── MessageBus
│     filters:progress  →  filters-matching (kick)
│     matching:progress →  tui
│     filters:match     →  blocks-download + tui
├── SqliteDatabase (filters.scanned + matched_blocks)
└── modules.start()
     └── filters-matching
           ├── deriveWatchWallet(seed, ADDRESS_GAP)
           ├── createBip158FilterMatcher()
           └── scan helper (batch / match / markScanned / emit)
```

**Keep (interface)**

- `createFiltersMatchingModule(ctx, options?) → Module` (`name: "filters-matching"`)
- `start` / `stop` lifecycle and `module:status` emissions
- Bus contract above
- Wiring in `main.tsx` and TUI matching tile (no UX redesign)

**Replace**

- Delete `src/modules/filters-match-client.ts`
- Delete `src/modules/filters-match-worker.ts`
- Rewrite matching guts; remove `scriptsNeedingMatch` usage from the module
- Replace `matched_external` / `matched_internal` with `scanned`

**Core pieces**

| Piece | Role |
|-------|------|
| `src/match/types.ts` | prior-style `FilterMatcher` (`matchAnyMany` / `matchAny`) |
| `src/match/bip158.ts` | `createBip158FilterMatcher()` wrapping `bip158` |
| `src/match/scan.ts` | Batch scan over SQLite: load unscanned → match → commit → progress/yield |
| `src/modules/filters-matching.ts` | Lifecycle, kick/idle loop, bus emits only |
| `db` | `scanned` column + repository methods below |

## Schema

**`filters` table**

- Remove use of `matched_external` / `matched_internal`
- Add `scanned INTEGER NOT NULL DEFAULT 0` (0 = needs match, 1 = done)
- Index: `(scanned, height)` for list/count hot paths
- New installs: create table with `scanned` only (no cursor columns)
- Existing DBs: add `scanned` if missing; **set all rows to 0**; drop cursor indexes; leave obsolete cursor columns in place if dropping is awkward under SQLite (they become unused)

**Repository API** (`FiltersRepository`)

Replace cursor APIs with:

- `listNeedingMatch(limit): FilterRecord[]` — `scanned = 0`, lowest height first
- `countScanned(): number`
- `markScanned(heights: number[]): void`
- `FilterRecord.scanned: number` (0 | 1)

Remove: `FilterMatchProgress`, gap parameters, `updateMatchProgress`, `countMatched(external, internal)`.

**Call sites outside matching**

- `tui-module.ts` seed progress: use `countScanned()` instead of `countMatched(ADDRESS_GAP, ADDRESS_GAP)`
- Tests that seed cursor fields: seed `scanned` instead

## Data flow

1. `start()` → status starting → reconcile `matching:progress` from DB → derive wallet → subscribe `filters:progress` → status running → enter loop.
2. Loop: while work remains, call scan helper for one or more batches; on empty work, reconcile progress and wait for kick (idle poll + wake).
3. Scan helper (prior-shaped):
   - Fetch up to `batchSize` (default **1000**) unscanned filters.
   - Decode filter bytes + display-order block hashes.
   - `matcher.matchAnyMany(filters, hashes, wallet.scripts)`.
   - Yield to event loop so OpenTUI can paint.
   - For each row: on hit, `matchedBlocks.insert` (if new → emit `filters:match`; already-present rows stay silent); always mark scanned.
   - Emit `matching:progress` every `progressEvery` rows (default **50**, prior cadence); yield periodically.
4. `stop()` → unsubscribe, wake waiter, await loop, status stopped.

After a reset migration, rematch may rediscover existing `matched_blocks` rows; insert-if-missing avoids duplicate downloads and duplicate `filters:match` events.

## Module options

```ts
type FiltersMatchingOptions = {
  seed?: string;
  addressGap?: number; // derivation only (default ADDRESS_GAP)
  batchSize?: number;
  progressEvery?: number;
  yieldFn?: () => Promise<void>;
  matcher?: FilterMatcher; // tests inject fakes; default bip158
};
```

No Worker / `matchFn` injection.

## Wallet

- Keep `ADDRESS_GAP` and `deriveWatchWallet` for the full watchlist.
- Delete `scriptsNeedingMatch` and its tests (cursor-era helper).

## Error handling

- Unexpected errors in the loop → emit `module:status` error with detail and exit the loop (same posture as today).
- `stop()` must not leave orphaned timers/waiters; no Worker to terminate.
- Busy + kick → dirty bit; after current pass, run again. Idle + kick → wake.

## Testing

| Area | Coverage |
|------|----------|
| `filters-matching` | Hit emits `filters:match` + inserts matched block; miss marks scanned without emit; already-scanned skipped; `matching:progress` on start/batches; idle resumes on `filters:progress`; busy dirty-bit drains new filters |
| `sqlite-filters` | `listNeedingMatch` / `countScanned` / `markScanned`; append defaults `scanned = 0` |
| Migration | Existing DB with cursor columns gets `scanned` and all zeros |
| Wallet | Drop `scriptsNeedingMatch` cases; keep derive tests |
| TUI matching progress | Seed via `scanned` / progress events unchanged |

## Project layout

```
src/
  match/
    types.ts
    bip158.ts
    scan.ts
  modules/
    filters-matching.ts          # shell only
    # DELETE filters-match-client.ts
    # DELETE filters-match-worker.ts
  db/
    schema.ts                    # scanned flag + migration reset
    types.ts
    sqlite-database.ts
  wallet/
    derive.ts                    # drop scriptsNeedingMatch
  tui/
    tui-module.ts                # countScanned for seed
tests/
  filters-matching.test.ts       # rewrite for scanned model
  sqlite-filters.test.ts         # scanned API
  wallet-derive.test.ts          # drop cursor helper tests
  tui-matching-progress.test.ts  # seed scanned
```

## Out of scope

- Changing TUI layout or progress event field names
- Changing blocks-download (still listens to `filters:match`)
- Porting a prior flat-file store / height-range scan machinery
- Incremental address-gap rematch when the watchlist grows later (future work if gap increases)
)