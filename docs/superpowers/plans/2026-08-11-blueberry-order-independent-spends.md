# Order-Independent Spend Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect P2PKH/P2SH-P2WPKH spends without prior UTXO knowledge, and re-queue already-missed spend blocks.

**Architecture:** Extend `extractWatchTxs` / `usedWatchIndexes` with pubkey→script matching from scriptSig and witness. Add a cheap outpoint blob search on downloaded blocks; clear matching `parsed_blocks` rows so parse-blocks re-extracts spends.

**Tech Stack:** Bun, TypeScript, bitcoinjs-lib, `bun:test`

**Spec:** `docs/superpowers/specs/2026-08-11-blueberry-order-independent-spends-design.md`

## Global Constraints

- Preserve unrelated uncommitted downloader changes.
- Do not change filter matching, download concurrency, or idle gating.
- Taproot key-path remains UTXO-map-only; orphan repair covers residual races.
- Commit only files belonging to each task.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/parse/extract.ts` | Pubkey→script helpers; order-independent spend match |
| `tests/unit/parse-extract.test.ts` | P2PKH / P2SH-P2WPKH spend without prior UTXO |
| `src/parse/used-indexes.ts` | Same matching for HD gap growth |
| `tests/unit/parse-used-indexes.test.ts` | P2PKH spend marks used index |
| `src/db/types.ts` / `src/db/sqlite-database.ts` | Outpoint search + clear one parsed height |
| `src/parse/orphan-spends.ts` | Pure repair planner over DB |
| `tests/unit/orphan-spends.test.ts` | Requeue heights with unrecorded spends |
| `src/modules/parse-blocks.ts` | Run repair on start and on `sync:idle` |
| `tests/unit/parse-blocks.test.ts` | Idle repair unmarks missed spend block |

### Task 1: Order-independent spend extraction

**Files:**
- Modify: `src/parse/extract.ts`, `tests/unit/parse-extract.test.ts`
- Modify: `src/parse/used-indexes.ts`, `tests/unit/parse-used-indexes.test.ts`

**Interfaces:**
- Produces: `p2pkhScriptFromPubkey`, `p2shP2wpkhScriptFromPubkey`, `watchedScriptsFromInput`
- Updates: `extractWatchTxs` / `usedWatchIndexes` to use them

- [ ] **Step 1: Write failing extract tests** for P2PKH scriptSig spend and P2SH-P2WPKH witness spend with empty UTXO map
- [ ] **Step 2: Verify red**
- [ ] **Step 3: Implement helpers + wire extract/used-indexes**
- [ ] **Step 4: Verify green + commit**

### Task 2: Orphan-spend repair

**Files:**
- Modify: `src/db/types.ts`, `src/db/sqlite-database.ts`
- Create: `src/parse/orphan-spends.ts`, `tests/unit/orphan-spends.test.ts`
- Modify: `src/modules/parse-blocks.ts`, `tests/unit/parse-blocks.test.ts`

**Interfaces:**
- Produces: `blocks.findHeightsContainingOutpoint(txid, vout, afterHeight)`
- Produces: `parsedBlocks.clear(height)`
- Produces: `requeueOrphanSpends(db, watchScripts): number` (cleared height count)

- [ ] **Step 1: Write failing orphan + parse-blocks idle repair tests**
- [ ] **Step 2: Verify red**
- [ ] **Step 3: Implement DB helpers, repair planner, parse-blocks wiring**
- [ ] **Step 4: Full unit verify + commit**
