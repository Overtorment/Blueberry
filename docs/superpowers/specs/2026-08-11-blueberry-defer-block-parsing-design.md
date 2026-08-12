# Defer Block Parsing Until Sync Idle

## Goal

Stop block parsing from competing with filter/block downloads for CPU on weak machines. Parse downloaded matched blocks only when catch-up is fully idle. Always show the simple `x/y` parse backlog line; show parse ETA only while parsing is active.

## Decisions

- Gate on existing `sync:idle` / `sync:catchup` (same signal peers/headers/filters/blocks already use).
- Idle means filters are tip-complete and every matched block is downloaded (current `sync-idle` semantics). Parse backlog is intentionally not part of idle evaluation.
- Gap growth that rematches filters returns the app to catch-up; parsing pauses until idle again.
- Scope is `parse-blocks` only; filters-matching keeps running during catch-up.
- Parse ETA sampling uses the same idle/catch-up events, resets on every transition, and never counts paused time.

## Behavior

1. Startup: `parse-blocks` starts, refreshes the wallet, but does **not** run an immediate parse batch.
2. While catch-up (`allowed = false`): the parse loop waits; no `Block.fromBuffer` / extract work.
3. On `sync:idle`: set `allowed = true` and kick the loop to drain `blocks.listNeedingParse`.
4. On `sync:catchup`: set `allowed = false`. If a block is mid-parse, finish that single block, then pause before the next one.
5. `blocks:progress` still marks backlog / kicks, but parsing only proceeds when `allowed`.
6. Gap growth (existing): may mark filters unscanned and emit filter progress → `sync-idle` leaves idle → parse pauses automatically, then resumes after the new filter/block catch-up completes.

## UI

- Keep one status line when backlog exists: `x/y blocks parsed` (already in `Transactions`).
- While catch-up is active, show only `x/y blocks parsed`.
- When `sync:idle` resumes parsing, start fresh ETA sampling. Show ETA after two advancing parse samples establish a rate.
- On `sync:catchup`, clear and hide ETA immediately; paused time must not affect the next estimate.
- `wallet-txs-store` owns the active flag, ETA samples, and estimate. The TUI module forwards `sync:idle` / `sync:catchup` through a dedicated store method.

## Non-goals

- Changing filter/block download concurrency or timeouts.
- Pausing filters-matching.
- Moving parse off-thread / worker.
- Changing single-use block peer privacy rules.

## Tests

- No parse before the first `sync:idle`.
- No parse while `sync:catchup` is active.
- After `sync:idle`, pending downloaded blocks are parsed.
- Mid-backlog `sync:catchup` pauses further parsing; a later `sync:idle` resumes.
- While paused, Transactions shows `x/y` without ETA.
- While parsing, ETA appears after two advancing samples.
- Pausing clears ETA; resuming starts a fresh sample window that excludes paused time.

## Risks

- Wallet txs stay empty until first idle after catch-up (expected; downloads stay fast).
- Idle requires two consecutive idle evaluations today; parse starts slightly after true backlog-clear (acceptable).
