# blueberry parse-blocks ETA in Transactions design

Date: 2026-08-06  
Status: proposed

## Goal

Show an ETA for block parsing inside the Transactions panel, using in-memory progress samples (not SQLite). Hide progress + ETA when parsing is complete. Keep the tx list within the panel height when the extra ETA row appears.

## Decisions

| Topic | Choice |
|-------|--------|
| Persistence | In-memory samples only (no `parsed_blocks` timestamp column) |
| Store | Extend `wallet-txs-store` (counts/`at` already arrive via `wallet:txs`) |
| ETA algorithm | Reuse `nextProgressSamples` + `estimateEtaMs` (`blocksParsed` as downloaded, `blocksTotal` as total) |
| ETA visibility | Show `ETA …` only when backlog exists **and** `etaMs !== null` (≥2 advancing samples) |
| Done | When `blocksParsed >= blocksTotal`, hide progress line and ETA (same as today’s progress hide) |
| Formatting | Reuse `formatEta` from `progress-format.ts` |
| Layout capacity | `reservedLines` = number of status lines shown (1 progress, or 2 when ETA visible) |

## Architecture

```
parse-blocks module
  → bus.emit("wallet:txs", { at, … })
tui-module
  → walletTxsStore.apply(snapshotFromDb(db, at))
     + maintain parse ETA samples from (at, blocksParsed, blocksTotal)
Transactions panel
  → optional "N/M blocks parsed"
  → optional "ETA …"
  → tx rows sliced to txListCapacity(termHeight, reservedLines)
```

No change to bus event shapes or parse-blocks module emits.

## Store behavior

`WalletTxsSnapshot` gains:

| Field | Meaning |
|-------|---------|
| `etaMs` | ms until all downloaded blocks are parsed; `null` if unknown; unused when no backlog |

On `apply(snapshot)`:

- Feed `{ at, downloaded: blocksParsed, total: blocksTotal }` through `nextProgressSamples` (resets on regress / leave-done).
- If backlog (`blocksTotal > blocksParsed`): `etaMs = estimateEtaMs(samples, blocksTotal)`.
- If no backlog: `etaMs = null` and samples may reset via leave-done / completion path so a later resume does not span idle time.
- Snapshot `at` remains the event time; samples are store-private.

## UI

While `blocksTotal > blocksParsed`:

1. `N/M blocks parsed` (existing)
2. `ETA {formatEta(etaMs)}` only when `etaMs !== null`

When backlog clears: neither line. Tx list uses `reservedLines` matching visible status lines so it does not overflow the panel.

## Out of scope

- Persisting parse timestamps in SQLite
- Progress bar (counts text only, as today)
- Separate parse-progress store / bus topic

## Tests

- Store: advancing parse counts produce ETA; &lt;2 samples → null; complete → null + status hidden at UI; resume after done does not rate across idle.
- `txListCapacity`: reservedLines 2 reduces capacity by one vs reservedLines 1 (existing helper already parameterized).
