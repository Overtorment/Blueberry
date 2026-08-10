# Parse-blocks ETA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show parse ETA in the Transactions panel from in-memory samples; hide with progress when done; reserve list rows so the panel does not overflow.

**Architecture:** Extend `wallet-txs-store` with `etaMs` via `nextProgressSamples` / `estimateEtaMs`. Update `Transactions.tsx` reserved lines.

**Tech stack:** Bun, TypeScript, existing TUI stores / `progress-eta.ts` / `formatEta`.

## File map

| File | Role |
|------|------|
| `src/tui/wallet-txs-store.ts` | Sample window + `etaMs` on apply |
| `src/tui/components/Transactions.tsx` | ETA row + reservedLines |
| `tests/wallet-txs-store-eta.test.ts` (new) or extend existing | ETA behavior |
| `tests/tui-tx-list-capacity.test.ts` | reservedLines=2 |

## Tasks

### Task 1: Store ETA

- [ ] Add `etaMs` to snapshot + empty snapshot (`null`)
- [ ] On `apply`, update samples from `(at, blocksParsed, blocksTotal)`; set `etaMs` when backlog else `null`
- [ ] Tests: &lt;2 samples → null; advancing → ETA; done → null; resume after idle not inflated

### Task 2: Transactions UI

- [ ] Show `ETA {formatEta(etaMs)}` only when backlog && `etaMs !== null`
- [ ] `reservedLines` = 1 or 2 matching visible status lines
- [ ] Capacity test for reservedLines=2

### Task 3: Commit

- [ ] Single commit for the feature (+ spec/plan if untracked)
