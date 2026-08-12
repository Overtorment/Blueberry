# Order-Independent Spend Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect P2PKH/P2SH-P2WPKH spends without prior UTXO knowledge.

**Architecture:** Extend `extractWatchTxs` / `usedWatchIndexes` with pubkey→script matching from scriptSig and witness so parse order cannot drop legacy spends.

**Tech Stack:** Bun, TypeScript, bitcoinjs-lib, `bun:test`

**Spec:** `docs/superpowers/specs/2026-08-11-blueberry-order-independent-spends-design.md`

## Global Constraints

- Preserve unrelated uncommitted downloader changes.
- Do not change filter matching, download concurrency, or idle gating.
- Do not ship orphan-spend healing / requeue passes.
- Taproot key-path remains UTXO-map-only.
- Commit only files belonging to each task.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/parse/extract.ts` | Pubkey→script helpers; order-independent spend match |
| `tests/unit/parse-extract.test.ts` | P2PKH / P2SH-P2WPKH spend without prior UTXO |
| `src/parse/used-indexes.ts` | Same matching for HD gap growth |
| `tests/unit/parse-used-indexes.test.ts` | P2PKH spend marks used index |

### Task 1: Order-independent spend extraction

**Files:**
- Modify: `src/parse/extract.ts`, `tests/unit/parse-extract.test.ts`
- Modify: `src/parse/used-indexes.ts`, `tests/unit/parse-used-indexes.test.ts`

**Interfaces:**
- Produces: `p2pkhScriptFromPubkey`, `p2shP2wpkhScriptFromPubkey`, `watchedScriptsFromInput`
- Updates: `extractWatchTxs` / `usedWatchIndexes` to use them

- [x] **Step 1: Write failing extract tests** for P2PKH scriptSig spend and P2SH-P2WPKH witness spend with empty UTXO map
- [x] **Step 2: Verify red**
- [x] **Step 3: Implement helpers + wire extract/used-indexes**
- [x] **Step 4: Verify green + commit**
