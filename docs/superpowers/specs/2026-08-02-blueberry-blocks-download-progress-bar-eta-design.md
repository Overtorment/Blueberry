# blueberry blocks download progress bar + ETA design

Date: 2026-08-02  
Status: approved (conversation)

## Goal

Show a progress bar and ETA on the Blocks download TUI tile, matching the Filters download layout. ETA appears only once enough advancing progress samples exist to estimate a rate.

## Decisions

| Topic | Choice |
|-------|--------|
| Layout | Match `FiltersDownload`: bar → `downloaded/matched` → `ETA …` (hidden at 100%) |
| ETA algorithm | Sliding window of advancing `downloaded` samples (same rules as filters/headers) |
| Store | Extend existing `blocks-matched-store` (do not invent a parallel store) |
| Bus event | Keep `blocks:progress { at, downloaded, matched }`; pass `at` into the store |
| Formatting | Reuse `progressBar` / `formatEta` from `progress-format.ts` |

## Architecture

```
blocks-download module
  → bus.emit("blocks:progress", { at, downloaded, matched })
tui-module
  → blocksMatchedStore.applyEvent({ at, downloaded, matched })
BlocksDownload tile
  → progressBar(percent), counts, ETA when percent < 100
```

No change to the download module’s emit shape. Work is confined to the TUI store, wiring, hook empty snapshot, component, and tests.

## Store behavior

`BlocksProgress` becomes:

| Field | Meaning |
|-------|---------|
| `downloaded` | Blocks persisted |
| `matched` | Matched blocks (denominator / total) |
| `at` | Timestamp of last applied event (`null` before any) |
| `etaMs` | ms until complete; `null` if unknown; `0` when done |
| `percent` | `0..100`, floor of `100 * downloaded / matched` (0 when matched is 0) |

**Samples**

- Keep up to 8 samples of `{ at, downloaded }`.
- Only append when `downloaded` advances (same `addAdvancingSample` rule as filters).
- `estimateEtaMs`: need ≥2 samples, positive time delta, positive rate; remaining = `matched - last.downloaded`.
- When `matched > 0` and `downloaded >= matched` → `etaMs = 0` (done), regardless of window.

**`setMatched(matched)`**

- Updates the matched total (and recomputes percent/ETA from existing samples).
- Does **not** add a download sample (match events are not download advances).

**Seed / bus wiring**

- TUI start seed and `blocks:progress` handler both pass `at` into `applyEvent`.
- Seed uses `Date.now()` like other progress tiles.

## UI

```
[##########----------] 50%
5/10
ETA 1m 20s
```

- While `percent < 100`, show `ETA {formatEta(etaMs)}` (`—` when `etaMs` is null).
- At 100%, omit the ETA line (same as filters).

## Testing

- Unit tests on the store: percent, ETA null with &lt;2 advancing samples, ETA after advances, done → 0, `setMatched` without inventing samples.
- Update `tests/tui-blocks-matched.test.ts` expectations for the richer snapshot (including `at` from bus events).

## Out of scope

- Changing download concurrency, peer selection, or `blocks:progress` emit cadence.
- Renaming `blocks-matched-store` / hook files (keep existing names).
- Extracting shared ETA helpers into a common module (copy/adapt filters pattern locally; dedupe later if desired).
