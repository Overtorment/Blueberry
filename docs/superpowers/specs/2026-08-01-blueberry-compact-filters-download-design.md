# blueberry compact filters download design

Date: 2026-08-01  
Status: approved (conversation)

## Goal

Download and verify BIP-157 basic compact filters for every height that has a stored block header. Kick off as soon as the module starts; when caught up, sit idle until `headers:progress` arrives; ignore kicks while a download is already in progress. Show progress (bar + ETA) in the TUI.

## Decisions

| Topic | Choice |
|-------|--------|
| Architecture | Module + net helper + typed SQLite repos on `Database` (Approach A) |
| Height range | Contiguous headers DB only: `[headers.minHeight … headers.tip]` — **not** hardcoded to 550000 |
| Verification | Yes — `cfcheckpt` + `cfheaders` bind the chain; each `cfilter` verified via `bip157` |
| Sync helper | Mid-chain path using `bip157` wire/verify helpers (not genesis `createFilterSync`) |
| Peers | Alive peers advertising `NODE_COMPACT_FILTERS` (`1 << 6`) only |
| Concurrency | Shared work queue, up to N sessions (default **30**); **no** race pool |
| Trigger | Start on init; busy ignores further kicks; idle + `headers:progress` → download remaining |
| Progress event | `filters:progress { at, downloaded, total }` after each successful persist batch |
| Storage | Behind `Database` / repository interfaces only (`ctx.db`); no direct SQLite in the module |
| Inter-module communication | Bus only |

## Architecture

```
main
 ├── MessageBus (+ filters:progress)
 ├── SqliteDatabase (peers + headers + filter_headers + filters)
 │     implements Database interface
 └── modules.start()
      ├── chain-headers        → headers:progress
      ├── filters-download     → listens headers:progress; emits filters:progress
      └── tui                  → filters:progress → progress store → FiltersDownload tile
```

**Core pieces**

- `config` — `filterSyncTimeoutMs`, `filterConcurrency` (default 30), optional batch sizes capped by BIP-157 maxima
- `net/filter-sync.ts` — BIP-324 session helper: connect/handshake, BIP-157 opaque send/recv
- `modules/filters-download.ts` — lifecycle, idle/busy gate, header catch-up, concurrent filter fetch, persist, emit progress
- `db` — typed `filterHeaders` + `filters` on `Database`
- TUI — `filters-progress-store` + Filters download tile (bar, counts, ETA)

**Busy / idle**

1. `start()` → mark busy → download for current header range.
2. When every header height in range has a filter → mark idle and wait.
3. On `headers:progress`: if busy, ignore; if idle, mark busy and download remaining.
4. `stop()` → cancel waiters, close sessions.

## Project layout

```
src/
  config.ts                      # + filter sync constants
  bus/types.ts                   # + filters:progress
  db/
    types.ts                     # + FilterHeadersRepository / FiltersRepository
    schema.ts                    # + filter_headers, filters tables
    sqlite-database.ts           # implementations
  net/
    filter-sync.ts               # NEW — BIP-157 over BIP-324 session helper
  modules/
    filters-download.ts          # real download (replaces scaffold)
  tui/
    filters-progress-store.ts    # NEW
    use-filters-progress.ts      # NEW
    tui-module.ts                # subscribe filters:progress
    components/FiltersDownload.tsx
```

## Data model

Storage stays behind `Database`. Modules use `ctx.db` only.

**`filter_headers`**

| Column | Type | Meaning |
|--------|------|---------|
| `height` | INTEGER PRIMARY KEY | block height |
| `header_hex` | TEXT NOT NULL | 32-byte filter header (hex) |

**`filters`**

| Column | Type | Meaning |
|--------|------|---------|
| `height` | INTEGER PRIMARY KEY | block height |
| `block_hash_internal_hex` | TEXT NOT NULL | internal-order block hash |
| `filter_hex` | TEXT NOT NULL | compact filter bytes |

```ts
interface FilterHeadersRepository {
  tip(): { height: number; headerHex: string } | null;
  get(height: number): { height: number; headerHex: string } | null;
  minHeight(): number | null;
  append(rows: { height: number; headerHex: string }[]): void;
  deleteFrom(height: number): void;
}

interface FiltersRepository {
  count(): number;
  has(height: number): boolean;
  /** Missing contiguous spans in [from, to], each span at most maxSpan long. */
  missingRanges(
    from: number,
    to: number,
    maxSpan: number,
  ): Array<{ from: number; to: number }>;
  append(
    rows: {
      height: number;
      blockHashInternalHex: string;
      filterHex: string;
    }[],
  ): void;
  deleteFrom(height: number): void;
}
```

`Database` gains `filterHeaders` and `filters` alongside `peers` and `headers`.

**Range source of truth:** lowest and tip heights in `headers` — never a hardcoded checkpoint height. Today that min height is the seeded header checkpoint; when the checkpoint becomes configurable later, this module keeps working unchanged.

`HeadersRepository` gains `minHeight(): number | null` (or equivalent) so filters-download does not assume a checkpoint constant.

**Progress totals**

- `total = tipHeight - minHeight + 1` (header coverage)
- `downloaded =` number of persisted filters with heights in that range
- Emit after each successful filter persist batch (and on start from DB state if useful)

**Reorg / tip regression**

On each download run (init or kick), reconcile before fetching:

1. If filter data exists above current headers tip → `deleteFrom(headersTip + 1)` on both filter tables.
2. Walk from filter tip downward (or check the overlap tip) until `filters.block_hash_internal_hex` matches `headers.hash_internal_hex` at that height; `deleteFrom` the first mismatch height on both filter tables.
3. Then download remaining for the current `[minHeight, tip]`.

## Sync loop & networking

**Config** (own constants — filter batches are larger than header batches):

| Knob | Default | Notes |
|------|---------|-------|
| `filterSyncTimeoutMs` | 120_000 | response budget after handshake |
| `filterConcurrency` | 30 | max in-flight range sessions |
| `filterHeaderBatchSize` | ≤ `MAX_GETCFHEADERS_RANGE` (2000) | cfheaders batch |
| `filterBatchSize` | ≤ `MAX_GETCFILTERS_RANGE` (1000) | getcfilters batch |
| connect timeout | `peerProbeTimeoutMs` | reuse peer probe |

Env wiring via existing `loadConfig` pattern (`BLUEBERRY_FILTER_*`).

**Peer selection**

- `db.peers.listAlive()` filtered by `services & NODE_COMPACT_FILTERS`.
- Session-local `dead` set; rotate; when exhausted, clear and restart.
- Do **not** mutate DB `alive`.
- No race pool (unlike chain-headers).

**Phase 1 — filter headers (sequential)**

Must chain; not parallelized.

1. Read `from` / `to` from headers DB. If headers empty, wait for kicks / peers.
2. `getcfcheckpt(stopHash = tip block hash)`.
3. `getcfheaders` batches from the first height still needing a filter header through `to`, using our stored block hashes as stop hashes.
4. Derive headers with `bip157`; verify against checkpoints that fall in-range; persist.
5. Mid-chain bootstrap: authenticate the peer’s `previousFilterHeader` by matching derived headers to BIP-157 checkpoints inside the range — no pre-`from` block hashes required.

**Phase 2 — filters (concurrent)**

1. Build a work queue of missing height ranges (`filterBatchSize`, BIP-157 capped).
2. Run up to `filterConcurrency` sessions; each takes the next range, sends `getcfilters`, reads `cfilter` messages, verifies with `verifyCFilterAgainstHeader`, persists, emits `filters:progress`.
3. On peer failure: mark session-dead, put range back on the queue.

**Idle**

When `missingRanges(from, to, …)` is empty → idle and wait.

**Kick**

`headers:progress` while idle → recompute `[from, to]` and run again. While busy → ignore.

## TUI

Mirror chain-tip progress:

- `filters-progress-store.ts` — same ETA sampling as headers (≥2 advancing `downloaded` samples)
- `use-filters-progress.ts` — `useSyncExternalStore`
- `tui-module` subscribes to `filters:progress` and applies to the store
- `FiltersDownload` tile: progress bar, `downloaded/total`, ETA (replace bare module-status text once progress is available)

## Lifecycle

- `main` passes filter config into `createFiltersDownloadModule`.
- Start order unchanged (TUI first; domain modules after).
- Subscribe to `headers:progress` and `peers:updated` (wake when compact-filter peers appear).
- `stop()` cancels waiters and closes sessions (best-effort).

## Error handling

- Connect / timeout / protocol errors: session-skip peer, continue.
- Verification mismatch: do not persist; session-skip peer; re-queue range.
- No `NODE_COMPACT_FILTERS` peers: wait on `peers:updated` / kicks.
- SQLite open/migrate failure at boot: fail fast (unchanged).
- Bus handler errors remain isolated.

## Testing

- Filter header / filter repository unit tests on `:memory:` SQLite: append, missingRanges, deleteFrom, count.
- Module unit tests with injectable net helpers / fake peers:
  - starts download on init when headers + compact-filter peers exist
  - busy ignores `headers:progress`
  - idle + `headers:progress` starts again for remaining heights
  - emits `filters:progress` with downloaded/total after successful batches
  - rejects mismatched filters (no persist)
- Progress store / ETA unit tests (reuse headers-store patterns).
- No live mainnet in CI.

## Success criteria

- Filters cover exactly the stored header height range (no hardcoded start height).
- Verification required before persist.
- Init starts download; idle waits; duplicate kicks while busy are ignored.
- Concurrency defaults to 30; no race pool; own timeouts/batch sizes.
- TUI shows bar, counts, and ETA after enough progress events.
- `bun test` and `bun run typecheck` pass.

## Out of scope

- Address matching (`filters-matching`)
- Block download / parse / balance
- Making the header checkpoint configurable (this module already keys off headers DB)
- Extending `bip157` `createFilterSync` for mid-chain start
- Serving compact filters
- Clearing or setting peer `alive` from this module
