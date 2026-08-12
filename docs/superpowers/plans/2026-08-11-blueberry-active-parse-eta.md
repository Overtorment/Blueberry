# Active Parse ETA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display block-parse ETA only while parsing is allowed and active, without counting catch-up pauses.

**Architecture:** Restore ETA sampling in `wallet-txs-store` behind a new `setParsingActive(active)` method. The TUI module forwards the same `sync:idle` / `sync:catchup` events that gate `parse-blocks`; each transition resets samples, and catch-up clears the visible ETA.

**Tech Stack:** Bun, TypeScript, existing message bus and external-store pattern.

**Spec:** `docs/superpowers/specs/2026-08-11-blueberry-defer-block-parsing-design.md`

## Global Constraints

- Always retain the `x/y blocks parsed` backlog line.
- ETA is hidden while catch-up is active.
- ETA starts fresh after every `sync:idle` and appears only after two advancing samples.
- Paused time must never affect a resumed ETA.
- Do not change parse scheduling, download behavior, concurrency, timeouts, or single-use peer rules.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/tui/wallet-txs-store.ts` | Track parsing-active state, fresh samples, and active-only ETA |
| `tests/unit/wallet-txs-store-eta.test.ts` | Store ETA lifecycle regressions |
| `src/tui/tui-module.ts` | Forward idle/catch-up events to the wallet store |
| `tests/unit/tui-wallet-txs.test.ts` | Verify real bus wiring and pause/resume sample reset |
| `src/tui/components/Transactions.tsx` | Render ETA only when the store has an estimate |
| `tests/unit/tui-tx-list-capacity.test.ts` | Preserve row-capacity behavior with one or two status lines |

---

### Task 1: Restore active-only ETA in the wallet transaction store

**Files:**
- Modify: `src/tui/wallet-txs-store.ts`
- Modify: `tests/unit/wallet-txs-store-eta.test.ts`

**Interfaces:**
- Produces: `WalletTxsStore.setParsingActive(active: boolean): void`
- Produces: `etaMs: number | null`, non-null only after two active advancing samples

- [ ] **Step 1: Write failing lifecycle tests**

Replace the current test body in `tests/unit/wallet-txs-store-eta.test.ts` with tests equivalent to:

```typescript
describe("wallet txs store active parse ETA", () => {
  test("estimates only while parsing is active", () => {
    const store = createWalletTxsStore();
    store.apply(snap({ at: 1000, blocksParsed: 100, blocksTotal: 1000 }));
    store.apply(snap({ at: 2000, blocksParsed: 200, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();

    store.setParsingActive(true);
    store.apply(snap({ at: 3000, blocksParsed: 300, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();
    store.apply(snap({ at: 4000, blocksParsed: 400, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBe(6000);
  });

  test("pause clears ETA; resume excludes paused time", () => {
    const store = createWalletTxsStore();
    store.setParsingActive(true);
    store.apply(snap({ at: 1000, blocksParsed: 100, blocksTotal: 1000 }));
    store.apply(snap({ at: 2000, blocksParsed: 200, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBe(8000);

    store.setParsingActive(false);
    expect(store.get().etaMs).toBeNull();
    store.apply(snap({ at: 1_000_000, blocksParsed: 300, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();

    store.setParsingActive(true);
    store.apply(snap({ at: 1_001_000, blocksParsed: 400, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();
    store.apply(snap({ at: 1_002_000, blocksParsed: 500, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBe(5000);
  });
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
bun test tests/unit/wallet-txs-store-eta.test.ts
```

Expected: FAIL because `setParsingActive` does not exist.

- [ ] **Step 3: Implement the store state machine**

In `src/tui/wallet-txs-store.ts`:

- Restore imports for `estimateEtaMs` and `nextProgressSamples`.
- Add `setParsingActive(active: boolean): void` to `WalletTxsStore`.
- Inside `createWalletTxsStore`, keep:

```typescript
let parsingActive = false;
let samples: { at: number; downloaded: number }[] = [];
```

- `setParsingActive` must reset `samples`; when disabling, replace the snapshot with `etaMs: null` and notify if the visible snapshot changed.
- `apply(next)` must keep ETA null and samples empty while inactive.
- While active, call `nextProgressSamples`, then set ETA to `estimateEtaMs(samples, next.blocksTotal)` only while `next.blocksTotal > next.blocksParsed`; completion clears ETA.
- Every false→true transition starts with an empty sample window.

- [ ] **Step 4: Verify green**

Run:

```bash
bun test tests/unit/wallet-txs-store-eta.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/tui/wallet-txs-store.ts tests/unit/wallet-txs-store-eta.test.ts
git commit -m "feat: estimate ETA only during active block parsing"
```

---

### Task 2: Wire sync state and restore conditional ETA rendering

**Files:**
- Modify: `src/tui/tui-module.ts`
- Modify: `tests/unit/tui-wallet-txs.test.ts`
- Modify: `src/tui/components/Transactions.tsx`
- Modify: `tests/unit/tui-tx-list-capacity.test.ts` only if its assertions/comments need the restored optional second status line

**Interfaces:**
- Consumes: `WalletTxsStore.setParsingActive(active)`
- Consumes: bus events `sync:idle`, `sync:catchup`
- Produces: one backlog line while paused; backlog + ETA lines while an estimate exists

- [ ] **Step 1: Write failing bus-wiring test**

Extend `tests/unit/tui-wallet-txs.test.ts` with a test that:

1. Seeds at least six downloaded blocks.
2. Starts the TUI and confirms ETA remains null before idle.
3. Emits `sync:idle`, marks/refreshes two parsed blocks at timestamps 1000 and 2000, and expects a non-null ETA.
4. Emits `sync:catchup` and expects ETA null immediately.
5. Advances a block during the long pause and confirms ETA remains null.
6. Emits `sync:idle`, advances twice at timestamps around 1,001,000 and 1,002,000, and expects ETA based only on that one-second active window.

- [ ] **Step 2: Verify red**

Run:

```bash
bun test tests/unit/tui-wallet-txs.test.ts
```

Expected: FAIL because the TUI does not forward sync state.

- [ ] **Step 3: Wire sync events**

In `src/tui/tui-module.ts`, add subscriptions during `start()`:

```typescript
ctx.bus.on("sync:idle", () => {
  walletTxsStore.setParsingActive(true);
}),
ctx.bus.on("sync:catchup", () => {
  walletTxsStore.setParsingActive(false);
}),
```

The store defaults inactive, matching production startup in catch-up.

- [ ] **Step 4: Restore conditional ETA line**

In `src/tui/components/Transactions.tsx`:

- Restore `formatEta` import.
- Set `showEta = hasParseBacklog && w.etaMs !== null`.
- Reserve `(hasParseBacklog ? 1 : 0) + (showEta ? 1 : 0)` rows.
- Render `ETA ${formatEta(w.etaMs)}` only when `showEta`.
- Keep `x/y blocks parsed` regardless of ETA.

Ensure `tests/unit/tui-tx-list-capacity.test.ts` still documents/tests both one-line and two-line reservation scenarios.

- [ ] **Step 5: Verify task**

Run:

```bash
bun test tests/unit/tui-wallet-txs.test.ts tests/unit/wallet-txs-store-eta.test.ts tests/unit/tui-tx-list-capacity.test.ts
bun run typecheck
```

Expected: all pass.

- [ ] **Step 6: Full verification**

Run:

```bash
bun run test:unit
git diff --check
```

Expected: 0 failures and no whitespace errors.

- [ ] **Step 7: Commit**

```bash
git add src/tui/tui-module.ts tests/unit/tui-wallet-txs.test.ts src/tui/components/Transactions.tsx tests/unit/tui-tx-list-capacity.test.ts
git commit -m "feat: show ETA when block parsing resumes"
```
