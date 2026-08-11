# Defer Block Parsing Until Sync Idle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pause `parse-blocks` until `sync:idle`, pause again on `sync:catchup`, and drop parse ETA from the TUI (keep `x/y blocks parsed`).

**Architecture:** Reuse the existing `sync:idle` / `sync:catchup` bus events. `parse-blocks` keeps an `allowed` flag; the loop only calls `parseBatch` when `allowed`. Existing parse tests emit `sync:idle` after `start()` so they still exercise parsing.

**Tech Stack:** Bun, TypeScript, existing message bus + module pattern.

**Spec:** `docs/superpowers/specs/2026-08-11-blueberry-defer-block-parsing-design.md`

## Global Constraints

- Gate on bus events only — do not reimplement idle evaluation inside `parse-blocks`.
- Do not parse before the first `sync:idle` (no startup `parseBatch`).
- On `sync:catchup`, finish the current block if mid-parse, then pause before the next block.
- Gap growth / filter rematch stays unchanged; catch-up automatically pauses parse.
- Filters-matching is out of scope.
- TUI: keep `x/y blocks parsed`; remove parse ETA line and stop computing it.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/modules/parse-blocks.ts` | `allowed` gate on `sync:idle` / `sync:catchup`; no startup parse |
| `tests/unit/parse-blocks.test.ts` | Gating tests + emit idle in existing cases |
| `tests/unit/parse-blocks-gap.test.ts` | Emit idle after start |
| `tests/unit/idempotent-blocks-txs.test.ts` | Emit idle after start |
| `tests/unit/wallet-secret-modules.test.ts` | Emit idle after start (if it waits on parse) |
| `src/tui/wallet-txs-store.ts` | Stop computing parse `etaMs` (always null) |
| `src/tui/components/Transactions.tsx` | Remove ETA line; reserved lines = backlog only |
| `tests/unit/wallet-txs-store-eta.test.ts` | Expect null ETA always (or replace with no-ETA assertions) |

---

### Task 1: Gate parse-blocks on sync idle

**Files:**
- Modify: `src/modules/parse-blocks.ts`
- Modify: `tests/unit/parse-blocks.test.ts`
- Modify: `tests/unit/parse-blocks-gap.test.ts`
- Modify: `tests/unit/idempotent-blocks-txs.test.ts`
- Modify: `tests/unit/wallet-secret-modules.test.ts` (only if it awaits parse results)

**Interfaces:**
- Consumes: bus events `sync:idle` `{ at: number }`, `sync:catchup` `{ at: number; reason: ... }`
- Produces: parse runs only while `allowed === true` after first idle

- [ ] **Step 1: Write the failing gating tests**

In `tests/unit/parse-blocks.test.ts`, add (reuse existing helpers in that file):

```typescript
test("does not parse backlog until sync:idle", async () => {
  const bus = createMessageBus();
  const db = createSqliteDatabase(":memory:");
  const script = watchScript0();
  db.blocks.insert({
    height: 50,
    blockHashInternalHex: "ab".repeat(32),
    block: blockBytesWithReceive(script, 5000n),
  });

  let batches = 0;
  const wallet = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
  const mod = createParseBlocksModule(
    { bus, db },
    {
      wallet,
      idleDelayMs: 50,
      blockGapMs: 0,
      onParseBatch: () => {
        batches++;
      },
    },
  );
  await mod.start();
  await new Promise((r) => setTimeout(r, 80));
  expect(batches).toBe(0);
  expect(db.parsedBlocks.has(50)).toBe(false);

  bus.emit("sync:idle", { at: Date.now() });
  await waitFor(() => db.parsedBlocks.has(50) && db.transactions.count() === 1);
  expect(batches).toBeGreaterThanOrEqual(1);

  await mod.stop();
  db.close();
});

test("sync:catchup pauses parsing; sync:idle resumes", async () => {
  const bus = createMessageBus();
  const db = createSqliteDatabase(":memory:");
  const script = watchScript0();
  for (const h of [1, 2, 3]) {
    db.blocks.insert({
      height: h,
      blockHashInternalHex: h.toString(16).padStart(2, "0").repeat(32),
      block: blockBytesWithReceive(script, BigInt(h)),
    });
  }

  const wallet = createWallet(db, {
    secret: MNEMONIC,
    addressGap: config.gapLimit + 1,
  });
  let batches = 0;
  const mod = createParseBlocksModule(
    { bus, db },
    {
      wallet,
      idleDelayMs: 50,
      batchSize: 1,
      blockGapMs: 30,
      onParseBatch: () => {
        batches++;
        if (batches === 1) {
          bus.emit("sync:catchup", { at: Date.now(), reason: "blocks" });
        }
      },
    },
  );
  await mod.start();
  bus.emit("sync:idle", { at: Date.now() });
  await waitFor(() => db.parsedBlocks.has(1));
  await new Promise((r) => setTimeout(r, 120));
  expect(db.parsedBlocks.has(2)).toBe(false);
  expect(db.parsedBlocks.has(3)).toBe(false);

  bus.emit("sync:idle", { at: Date.now() });
  await waitFor(
    () =>
      db.parsedBlocks.has(2) &&
      db.parsedBlocks.has(3) &&
      db.transactions.count() === 3,
  );

  await mod.stop();
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/parse-blocks.test.ts --test-name-pattern 'does not parse backlog|sync:catchup pauses'`

Expected: FAIL — batches run on start / catch-up does not pause.

- [ ] **Step 3: Implement the idle gate**

In `src/modules/parse-blocks.ts`:

1. Add `let allowed = false;` and unsub handles for idle/catchup.
2. Remove the startup `parseBatch()` in `start()` (keep `wallet.refresh()` and status emits).
3. Subscribe:

```typescript
unsubIdle = ctx.bus.on("sync:idle", () => {
  if (stopped) return;
  allowed = true;
  if (busy) {
    needsRun = true;
    return;
  }
  kick();
});
unsubCatchup = ctx.bus.on("sync:catchup", () => {
  allowed = false;
});
```

4. In `loop()`, before `parseBatch`:

```typescript
if (!allowed) {
  busy = false;
  await waitForKick();
  continue;
}
```

5. In the per-block loop inside `parseBatch`, after finishing each block (after mark/emit/maybeGrow), if `!allowed` return early so catch-up pauses before the next block.
6. Keep `blocks:progress` kick behavior, but it must not parse while `!allowed` (loop gate handles this).
7. On `stop()`, unsubscribe idle/catchup and set `allowed = false`.

- [ ] **Step 4: Update existing parse tests to emit idle**

After every `await mod.start()` (and `mod2.start()`) that expects parsing, add:

```typescript
bus.emit("sync:idle", { at: Date.now() });
```

Files:
- `tests/unit/parse-blocks.test.ts` — rename/adjust "parses backlog on start…" to expect idle first; emit idle in other cases
- `tests/unit/parse-blocks-gap.test.ts`
- `tests/unit/idempotent-blocks-txs.test.ts`
- `tests/unit/wallet-secret-modules.test.ts` — only if the test waits for parsed blocks / txs

For `blocks:progress while busy…`, emit idle after start so the initial batch can run; keep the rest of the sequencing.

- [ ] **Step 5: Run parse-related tests**

Run:

```bash
bun test tests/unit/parse-blocks.test.ts tests/unit/parse-blocks-gap.test.ts tests/unit/idempotent-blocks-txs.test.ts tests/unit/wallet-secret-modules.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/modules/parse-blocks.ts tests/unit/parse-blocks.test.ts tests/unit/parse-blocks-gap.test.ts tests/unit/idempotent-blocks-txs.test.ts tests/unit/wallet-secret-modules.test.ts
git commit -m "$(cat <<'EOF'
feat: parse blocks only while sync is idle.

EOF
)"
```

---

### Task 2: Remove parse ETA from TUI

**Files:**
- Modify: `src/tui/wallet-txs-store.ts`
- Modify: `src/tui/components/Transactions.tsx`
- Modify: `tests/unit/wallet-txs-store-eta.test.ts`

**Interfaces:**
- Consumes: `WalletTxsSnapshot.blocksParsed` / `blocksTotal`
- Produces: `etaMs` always `null`; UI shows only `x/y blocks parsed`

- [ ] **Step 1: Write the failing store/UI expectations**

Replace `tests/unit/wallet-txs-store-eta.test.ts` contents with:

```typescript
import { describe, expect, test } from "bun:test";
import {
  createWalletTxsStore,
  emptyWalletTxsSnapshot,
  type WalletTxsSnapshot,
} from "../../src/tui/wallet-txs-store.ts";

function snap(
  partial: Pick<WalletTxsSnapshot, "at" | "blocksParsed" | "blocksTotal">,
): WalletTxsSnapshot {
  return {
    ...emptyWalletTxsSnapshot,
    ...partial,
    etaMs: null,
  };
}

describe("wallet txs store parse progress", () => {
  test("never estimates parse ETA (backlog uses x/y only)", () => {
    expect(emptyWalletTxsSnapshot.etaMs).toBeNull();
    const store = createWalletTxsStore();
    store.apply(snap({ at: 1000, blocksParsed: 100, blocksTotal: 1000 }));
    store.apply(snap({ at: 2000, blocksParsed: 200, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();
    expect(store.get().blocksParsed).toBe(200);
    expect(store.get().blocksTotal).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/wallet-txs-store-eta.test.ts`

Expected: FAIL — advancing backlog still yields non-null `etaMs`.

- [ ] **Step 3: Stop computing ETA; drop UI line**

In `src/tui/wallet-txs-store.ts` `apply()`:

- Remove sample / `estimateEtaMs` usage.
- Always set `etaMs: null` on apply.
- Remove unused imports (`estimateEtaMs`, `nextProgressSamples`) if nothing else needs them in that file.

In `src/tui/components/Transactions.tsx`:

- Remove `showEta`, ETA `<text>`, and `formatEta` import if unused.
- `reservedLines = hasParseBacklog ? 1 : 0`.
- Keep the `x/y blocks parsed` line.

- [ ] **Step 4: Run TUI-related tests**

Run:

```bash
bun test tests/unit/wallet-txs-store-eta.test.ts tests/unit/tui-tx-list-capacity.test.ts
```

Expected: PASS

- [ ] **Step 5: Full verification**

Run:

```bash
bun run typecheck
bun run test:unit
```

Expected: typecheck exit 0; unit tests 0 fail.

- [ ] **Step 6: Commit**

```bash
git add src/tui/wallet-txs-store.ts src/tui/components/Transactions.tsx tests/unit/wallet-txs-store-eta.test.ts
git commit -m "$(cat <<'EOF'
feat: drop parse ETA; keep x/y backlog line.

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| No parse until first `sync:idle` | Task 1 |
| Pause on `sync:catchup` | Task 1 |
| Resume on later idle | Task 1 |
| Finish current block then pause | Task 1 |
| Gap growth → catch-up pauses parse | Task 1 (existing rematch + new gate) |
| Keep `x/y blocks parsed` | Task 2 |
| Remove parse ETA | Task 2 |
| Filters-matching unchanged | Non-goal (no task) |
