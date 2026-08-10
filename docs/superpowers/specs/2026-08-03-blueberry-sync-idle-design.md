# blueberry sync idle design

Date: 2026-08-03  
Status: approved (conversation)

## Goal

When headers, filters, and blocks are fully synced, stop active peer discovery so the laptop can go quiet. Keep light tip-following so newly mined blocks are noticed. Resume peer discovery when the app falls behind or tip-follow peers become unhealthy. Once caught up again, stop discovery again.

## Decisions

| Topic | Choice |
|-------|--------|
| Caught-up definition | Headers at tip **and** all filters downloaded for the header range **and** all matched blocks downloaded |
| Restart discovery | Headers behind tip **or** filter/block download backlog **or** tip-follow peers unhealthy |
| Tip follow while idle | `chain-headers` keeps ~30s sticky peer poll; filters/blocks wake only on real tip advance (or catchup) |
| Ownership | Coordinator module (`sync-idle`) emits bus events; modules never import each other |
| Discovery control | Pause/resume probe loop (Approach 1) — not hard-stop/recreate, not mere rate-limit |
| Matching / parse | Do not keep discovery awake by themselves; new matched blocks needing download trigger catchup |
| TUI idle badge | Out of scope |
| Slowing parse/matching idle polls | Out of scope |
| Mid-probe socket kill on idle | Out of scope — finish in-flight probes, then pause |

## Architecture

```
sync-idle (coordinator)
  listens: headers/filters/blocks progress, peers:updated, slow timer
  reads:   DB + header tip vs known peer tip
  emits:   sync:idle | sync:catchup

peers-discovery
  sync:idle    → pause probes / DNS reseed / peers:updated spam
  sync:catchup → resume probe loop

chain-headers
  always: ~30s sticky tip poll
  sync:idle: ignore peers:updated kicks (tip poll remains)
  new headers → headers:progress (wakes filters)

filters-download / blocks-download
  sync:idle: do not requestRun / refill on peers:updated
  still wake on headers:progress, filters:match, sync:catchup
```

**Startup:** begin in catchup (discovery running). Transition to idle only after the first true caught-up evaluation.

**Inter-module rule:** bus only — same as the rest of blueberry.

## Sync state rules

### Caught up → emit `sync:idle`

All of the following must hold:

1. **Headers at tip:** local tip height ≥ known peer tip (`maxPeerStartHeight` / equivalent progress total already used by `chain-headers`). If peer tip is unknown (`0` / unset), not idle.
2. **Filters complete:** no missing filter ranges for `[headers.minHeight … headers.tip]`.
3. **Blocks complete:** no matched blocks needing download, and no in-flight block downloads.

Matching and parse may still run after idle; they alone do not force catchup. If matching inserts new matched blocks that need download, that is “behind” again.

### Behind → emit `sync:catchup`

Any of:

1. Headers behind peer tip (`reason: "headers"`)
2. Filter gaps for the header range (`reason: "filters"`)
3. Matched blocks pending download (or in-flight) (`reason: "blocks"`)
4. Tip-follow peer set unhealthy: no usable alive peer for header polling while trying to stay at tip; if filter catch-up is needed after tip advance, also treat “too few” compact-filter peers as unhealthy using the existing `minAliveCompactFilters` threshold (`reason: "peers"`)

### Hysteresis

- Emit each transition at most once per state change (no re-spam on every progress tick).
- Prefer entering idle only after headers have observed an empty batch at tip **and** filters/blocks are quiet, so transient peer-tip noise does not flap pause/resume.

### Evaluation cadence

Re-evaluate on:

- `headers:progress`, `filters:progress`, `blocks:progress`
- `peers:updated` (cheap check — especially peer-health / catchup reason `"peers"`)
- A slow fallback timer (~5–10s) so a missed event cannot leave discovery stuck paused or stuck running forever

## Bus events

Add to `EventMap`:

| Event | Payload | Meaning |
|-------|---------|---------|
| `sync:idle` | `{ at: number }` | Pause active discovery; quiet tip-follow mode |
| `sync:catchup` | `{ at: number; reason: "headers" \| "filters" \| "blocks" \| "peers" }` | Resume discovery; full pipeline may run |

## Module behavior details

### `sync-idle`

- New module, started from `main.tsx` with the other domain modules.
- Tracks last emitted mode: `"catchup" | "idle"` (start as `"catchup"`).
- Needs a way to know “headers at tip”. Prefer reading `headers:progress` (`downloaded` vs `total`) and/or a small shared tip signal from that event stream. Do not import `chain-headers`. If progress totals are `0`/unknown, treat as not at tip.
- For filters/blocks backlog, read DB (`filters.missingRanges`, `matchedBlocks.listNeedingDownload`). In-flight block downloads: either expose a bus hint from `blocks:progress` (`downloaded < matched`) or treat `downloaded < matched` as pending.
- On transition, emit the corresponding event and optionally `module:status` with detail (`idle` / `catchup:blocks`, etc.).

### `peers-discovery`

- Add paused flag. While paused: probe loop waits on `sync:catchup` (or stop), does not probe, does not DNS-reseed, does not emit `peers:updated`.
- On `sync:idle` while probes are in flight: do not spawn new probes; allow in-flight to finish (or abandon on module stop as today); then stay paused.
- On `sync:catchup`: clear pause and kick the loop.

### `chain-headers`

- Keep existing `pollIntervalMs` (~30s) sticky tip follow always.
- While idle (listen for `sync:idle` / `sync:catchup`): do not `kick()` from `peers:updated`. Still kick/run on the poll timer and on successful/failed fetch pacing as today.
- When idle and peers become unusable (repeated failures / no alive peers to race), emit progress or rely on empty alive set so `sync-idle` can raise `sync:catchup` with `reason: "peers"`.

### `filters-download`

- Track sync mode from bus.
- In idle mode: `peers:updated` must not call `requestRun("peers")` (may still `kick()` an in-flight wait if desired, but must not start a new reconcile solely because peers changed).
- Still run on `headers:progress` and on `sync:catchup`.

### `blocks-download`

- Track sync mode from bus.
- In idle mode: `peers:updated` must not wake a full pending scan solely for peer churn (same spirit as filters).
- Still wake on `filters:match`, `sync:catchup`, and the existing idle DB poll is acceptable at low frequency **or** can be lengthened while idle; must wake promptly when catchup is declared.

### `filters-matching` / `parse-blocks`

- No required changes for this design.
- Optional later: longer idle poll intervals (out of scope).

## Lifecycle example

1. App starts → catchup → discovery crawls, headers/filters/blocks sync.
2. Headers at tip, filters full, blocks full → `sync:idle` → discovery pauses.
3. ~30s later headers sticky poll sees a new block → headers append → `headers:progress`.
4. Filters (and maybe blocks) have work → coordinator emits `sync:catchup` (`filters` or `blocks`) → discovery resumes.
5. Pipeline catches tip again → `sync:idle` → discovery pauses.

## Testing

Unit tests with injected bus, DB, and time:

1. **Coordinator caught-up:** when tip synced and no filter/block backlog → emits `sync:idle` once; repeated evals do not re-emit.
2. **Coordinator behind:** each of headers / filters / blocks / peers conditions → `sync:catchup` with the matching `reason`.
3. **peers-discovery:** after `sync:idle`, no further probes; after `sync:catchup`, probes resume.
4. **filters-download / blocks-download:** while idle, `peers:updated` does not restart download work; `headers:progress` or `sync:catchup` does.

## Out of scope

- TUI visual for idle/catchup mode
- Changing header `pollIntervalMs`
- Worker threads / separate processes
- Deleting peers from SQLite when idle
- Hard `stop()`/`start()` recreation of `peers-discovery`

