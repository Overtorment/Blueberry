# Inline Block-Parse ETA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render block-parse progress and its optional ETA on one Transactions-panel row.

**Architecture:** Add a pure parse-progress formatter beside the existing ETA formatter, then have `Transactions` render one conditional status element. The transaction-row capacity calculation always reserves exactly one row while a parse backlog exists.

**Tech Stack:** Bun, TypeScript, React/OpenTUI, `bun:test`

**Spec:** `docs/superpowers/specs/2026-08-11-blueberry-inline-parse-eta-design.md`

## Global Constraints

- ETA-unavailable text is exactly `<parsed>/<total> blocks parsed`.
- ETA-available text is exactly `<parsed>/<total> blocks parsed (ETA <formatted-duration>)`.
- Hide parse progress when no backlog exists.
- Reserve exactly one Transactions-panel row while a backlog exists.
- Do not change ETA sampling, sync events, parsing, or downloading.
- Preserve unrelated uncommitted downloader changes.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/tui/progress-format.ts` | Build the complete parse-progress status text |
| `tests/unit/tui-progress-format.test.ts` | Verify text with and without ETA |
| `src/tui/components/Transactions.tsx` | Render one parse-progress row |
| `tests/unit/tui-tx-list-capacity.test.ts` | Verify one row is reserved |

### Task 1: Combine parse progress and ETA

**Files:**
- Modify: `src/tui/progress-format.ts`
- Modify: `tests/unit/tui-progress-format.test.ts`
- Modify: `src/tui/components/Transactions.tsx`
- Modify: `tests/unit/tui-tx-list-capacity.test.ts`

**Interfaces:**
- Produces: `formatParseProgress(parsed: number, total: number, etaMs: number | null): string`
- Consumes: existing `formatEta(etaMs: number | null): string`

- [ ] **Step 1: Write failing formatter and capacity tests**

Update `tests/unit/tui-progress-format.test.ts` to import the new formatter:

```typescript
import {
  formatEta,
  formatParseProgress,
  progressBar,
} from "../../src/tui/progress-format.ts";
```

Add:

```typescript
describe("formatParseProgress", () => {
  test("keeps ETA on the parse progress row only when available", () => {
    expect(formatParseProgress(332, 500, null)).toBe(
      "332/500 blocks parsed",
    );
    expect(formatParseProgress(332, 500, 65_000)).toBe(
      "332/500 blocks parsed (ETA 1m 5s)",
    );
  });
});
```

In `tests/unit/tui-tx-list-capacity.test.ts`, replace the two-line ETA assertion with:

```typescript
    // Progress and optional ETA share one row.
    expect(txListCapacity(24, 1)).toBe(4);
```

- [ ] **Step 2: Verify the new formatter test is red**

Run:

```bash
bun test tests/unit/tui-progress-format.test.ts tests/unit/tui-tx-list-capacity.test.ts
```

Expected: FAIL because `formatParseProgress` is not exported.

- [ ] **Step 3: Implement the formatter**

Add to `src/tui/progress-format.ts` after `formatEta`:

```typescript
export function formatParseProgress(
  parsed: number,
  total: number,
  etaMs: number | null,
): string {
  const progress = `${parsed}/${total} blocks parsed`;
  return etaMs === null ? progress : `${progress} (ETA ${formatEta(etaMs)})`;
}
```

- [ ] **Step 4: Render one status row**

In `src/tui/components/Transactions.tsx`, replace the `formatEta` import:

```typescript
import { formatParseProgress } from "../progress-format.ts";
```

Remove `showEta`, calculate capacity with one reserved row, and replace both parse-status elements:

```typescript
  const hasParseBacklog = w.blocksTotal > w.blocksParsed;
  const active =
    (status !== "idle" && status !== "…") ||
    w.txs.length > 0 ||
    hasParseBacklog;
  const reservedLines = hasParseBacklog ? 1 : 0;
```

```tsx
        {hasParseBacklog ? (
          <text fg={THEME.fgDim}>
            {formatParseProgress(
              w.blocksParsed,
              w.blocksTotal,
              w.etaMs,
            )}
          </text>
        ) : null}
```

- [ ] **Step 5: Verify targeted tests and typecheck**

Run:

```bash
bun test tests/unit/tui-progress-format.test.ts tests/unit/tui-tx-list-capacity.test.ts tests/unit/wallet-txs-store-eta.test.ts tests/unit/tui-wallet-txs.test.ts
bun run typecheck
```

Expected: all targeted tests PASS and typecheck exits 0.

- [ ] **Step 6: Run full unit verification**

Run:

```bash
bun test tests/unit
```

Expected: all unit tests PASS.

- [ ] **Step 7: Commit only the compact-row implementation**

```bash
git add src/tui/progress-format.ts \
  src/tui/components/Transactions.tsx \
  tests/unit/tui-progress-format.test.ts \
  tests/unit/tui-tx-list-capacity.test.ts
git -c user.name='Overtorment' -c user.email='overtorment@gmail.com' commit -m "fix: keep block parse ETA on progress row"
```
