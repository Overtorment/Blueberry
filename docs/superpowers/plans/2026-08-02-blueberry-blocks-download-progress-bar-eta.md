# blueberry Blocks Download Progress Bar + ETA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a progress bar and ETA on the Blocks download TUI tile, matching the Filters download layout.

**Architecture:** Extend `blocks-matched-store` with percent + sliding-window ETA (same rules as filters/headers). Pass `at` from `blocks:progress` / TUI seed into `applyEvent`. Update `BlocksDownload` to render bar, counts, and ETA via shared formatters.

**Tech Stack:** Bun, TypeScript, existing MessageBus + OpenTUI React tiles. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-02-blueberry-blocks-download-progress-bar-eta-design.md`.
- Layout must match `FiltersDownload`: bar → `downloaded/matched` → `ETA …` (hidden at 100%).
- ETA uses a sliding window of advancing `downloaded` samples (≥2 required); reuse `progressBar` / `formatEta` from `src/tui/progress-format.ts`.
- Do not change `blocks-download` emit shape or download logic.
- Keep file names `blocks-matched-store.ts` / `use-blocks-matched.ts`.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).

## File structure

| Path | Responsibility |
|------|----------------|
| `src/tui/blocks-matched-store.ts` | Counts + percent + ETA samples |
| `src/tui/use-blocks-matched.ts` | Hook empty snapshot fields |
| `src/tui/tui-module.ts` | Pass `at` on seed + `blocks:progress` |
| `src/tui/components/BlocksDownload.tsx` | Bar / counts / ETA |
| `tests/blocks-matched-store.test.ts` | Percent / ETA / setMatched |
| `tests/tui-blocks-matched.test.ts` | Bus → store wiring expectations |

---

### Task 1: Blocks progress store (percent + ETA)

**Files:**
- Modify: `src/tui/blocks-matched-store.ts`
- Create: `tests/blocks-matched-store.test.ts`

**Interfaces:**
- Consumes: none (self-contained store)
- Produces:

```ts
export type BlocksProgress = {
  downloaded: number;
  matched: number;
  at: number | null;
  etaMs: number | null;
  percent: number; // 0..100
};

export type BlocksMatchedStore = {
  get(): BlocksProgress;
  applyEvent(ev: { at: number; downloaded: number; matched: number }): void;
  setMatched(matched: number): void;
  subscribe(listener: () => void): () => void;
};

export function estimateEtaMs(
  samples: ReadonlyArray<{ at: number; downloaded: number }>,
  total: number,
): number | null;

export function createBlocksMatchedStore(): BlocksMatchedStore;
```

- [ ] **Step 1: Write the failing store test**

Create `tests/blocks-matched-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  createBlocksMatchedStore,
  estimateEtaMs,
} from "../src/tui/blocks-matched-store.ts";

describe("blocks matched store", () => {
  test("percent, eta, and ignore non-advancing samples", () => {
    const store = createBlocksMatchedStore();
    expect(store.get()).toMatchObject({
      downloaded: 0,
      matched: 0,
      at: null,
      etaMs: null,
      percent: 0,
    });

    store.applyEvent({ at: 1000, downloaded: 100, matched: 1000 });
    expect(store.get().percent).toBe(10);
    expect(store.get().etaMs).toBeNull();

    // same downloaded: updates time/matched but must not create an ETA sample pair
    store.applyEvent({ at: 1500, downloaded: 100, matched: 1000 });
    expect(store.get().etaMs).toBeNull();
    expect(store.get().at).toBe(1500);

    store.applyEvent({ at: 2000, downloaded: 200, matched: 1000 });
    // 100 blocks / 1000ms → 0.1 b/ms; remaining 800 → 8000ms
    expect(store.get().etaMs).toBe(8000);

    store.applyEvent({ at: 3000, downloaded: 1000, matched: 1000 });
    expect(store.get().percent).toBe(100);
    expect(store.get().etaMs).toBe(0);
  });

  test("estimateEtaMs rejects insufficient or flat samples", () => {
    expect(estimateEtaMs([{ at: 1, downloaded: 5 }], 10)).toBeNull();
    expect(
      estimateEtaMs(
        [
          { at: 1, downloaded: 5 },
          { at: 2, downloaded: 5 },
        ],
        10,
      ),
    ).toBeNull();
  });

  test("setMatched updates total without adding download samples", () => {
    const store = createBlocksMatchedStore();
    store.applyEvent({ at: 1000, downloaded: 100, matched: 500 });
    store.setMatched(1000);
    expect(store.get()).toMatchObject({
      downloaded: 100,
      matched: 1000,
      at: 1000,
      percent: 10,
      etaMs: null, // still only one advancing sample
    });

    store.applyEvent({ at: 2000, downloaded: 200, matched: 1000 });
    expect(store.get().etaMs).toBe(8000);

    store.setMatched(1200);
    // rate still 100/1000ms; remaining 1000 → 10000ms
    expect(store.get().etaMs).toBe(10_000);
    expect(store.get().percent).toBe(16);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/blocks-matched-store.test.ts`  
Expected: FAIL (missing fields / `at` on `applyEvent`)

- [ ] **Step 3: Implement the store**

Replace `src/tui/blocks-matched-store.ts` with:

```ts
export type BlocksProgress = {
  downloaded: number;
  matched: number;
  at: number | null;
  /** ms until complete; null if unknown */
  etaMs: number | null;
  percent: number; // 0..100
};

export type BlocksMatchedStore = {
  get(): BlocksProgress;
  applyEvent(ev: { at: number; downloaded: number; matched: number }): void;
  /** Update matched only; keep downloaded / samples. */
  setMatched(matched: number): void;
  subscribe(listener: () => void): () => void;
};

const MAX_SAMPLES = 8;

function addAdvancingSample(
  samples: { at: number; downloaded: number }[],
  sample: { at: number; downloaded: number },
): { at: number; downloaded: number }[] {
  const last = samples[samples.length - 1];
  if (last !== undefined && sample.downloaded <= last.downloaded) {
    return samples;
  }
  const next = [...samples, sample];
  if (next.length > MAX_SAMPLES) {
    return next.slice(-MAX_SAMPLES);
  }
  return next;
}

export function estimateEtaMs(
  samples: ReadonlyArray<{ at: number; downloaded: number }>,
  total: number,
): number | null {
  if (samples.length < 2) return null;

  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const timeDelta = last.at - first.at;
  if (timeDelta <= 0) return null;

  const rate = (last.downloaded - first.downloaded) / timeDelta;
  if (total <= last.downloaded) return 0;
  if (rate <= 0) return null;

  const remaining = total - last.downloaded;
  return Math.round(remaining / rate);
}

export function createBlocksMatchedStore(): BlocksMatchedStore {
  let downloaded = 0;
  let matched = 0;
  let at: number | null = null;
  let samples: { at: number; downloaded: number }[] = [];
  // Stable snapshot for useSyncExternalStore (Object.is); new object only on change.
  let snapshot: BlocksProgress = {
    downloaded: 0,
    matched: 0,
    at: null,
    etaMs: null,
    percent: 0,
  };
  const listeners = new Set<() => void>();

  function percentOf(nextDownloaded: number, nextMatched: number): number {
    return nextMatched === 0
      ? 0
      : Math.min(100, Math.floor((100 * nextDownloaded) / nextMatched));
  }

  function etaOf(
    nextSamples: ReadonlyArray<{ at: number; downloaded: number }>,
    nextDownloaded: number,
    nextMatched: number,
  ): number | null {
    if (nextMatched > 0 && nextDownloaded >= nextMatched) return 0;
    return estimateEtaMs(nextSamples, nextMatched);
  }

  function publish(
    nextDownloaded: number,
    nextMatched: number,
    nextAt: number | null,
    nextSamples: { at: number; downloaded: number }[],
  ): void {
    const nextPercent = percentOf(nextDownloaded, nextMatched);
    const nextEta = etaOf(nextSamples, nextDownloaded, nextMatched);
    if (
      downloaded === nextDownloaded &&
      matched === nextMatched &&
      at === nextAt &&
      snapshot.etaMs === nextEta &&
      snapshot.percent === nextPercent
    ) {
      return;
    }
    downloaded = nextDownloaded;
    matched = nextMatched;
    at = nextAt;
    samples = nextSamples;
    snapshot = {
      downloaded,
      matched,
      at,
      etaMs: nextEta,
      percent: nextPercent,
    };
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      return snapshot;
    },
    applyEvent(ev) {
      const nextSamples = addAdvancingSample(samples, {
        at: ev.at,
        downloaded: ev.downloaded,
      });
      publish(ev.downloaded, ev.matched, ev.at, nextSamples);
    },
    setMatched(nextMatched) {
      publish(downloaded, nextMatched, at, samples);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/blocks-matched-store.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (skip unless user asks)

```bash
git add src/tui/blocks-matched-store.ts tests/blocks-matched-store.test.ts
git commit -m "Add percent and ETA to blocks matched progress store."
```

---

### Task 2: Wire `at` through TUI seed + bus

**Files:**
- Modify: `src/tui/tui-module.ts`
- Modify: `src/tui/use-blocks-matched.ts`
- Modify: `tests/tui-blocks-matched.test.ts`

**Interfaces:**
- Consumes: `BlocksMatchedStore.applyEvent({ at, downloaded, matched })` from Task 1
- Produces: seed + `blocks:progress` handler pass `at`; hook empty snapshot includes new fields

- [ ] **Step 1: Update the failing wiring test**

Replace the body of `tests/tui-blocks-matched.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createBlocksMatchedStore } from "../src/tui/blocks-matched-store.ts";
import { createFiltersProgressStore } from "../src/tui/filters-progress-store.ts";
import { createHeadersProgressStore } from "../src/tui/headers-progress-store.ts";
import { createMatchingProgressStore } from "../src/tui/matching-progress-store.ts";
import { createPeerCountStore } from "../src/tui/peer-count-store.ts";
import { createModuleStatusStore } from "../src/tui/status-store.ts";
import { createTuiModule } from "../src/tui/tui-module.ts";

describe("TUI blocks progress wiring", () => {
  test("applies blocks:progress from the bus", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const blocksMatchedStore = createBlocksMatchedStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerCountStore(),
      createHeadersProgressStore(),
      createFiltersProgressStore(),
      createMatchingProgressStore(),
      blocksMatchedStore,
    );
    tui.start();
    expect(blocksMatchedStore.get()).toMatchObject({
      downloaded: 0,
      matched: 0,
      percent: 0,
      etaMs: null,
    });
    expect(blocksMatchedStore.get().at).not.toBeNull();

    bus.emit("blocks:progress", {
      at: 1,
      downloaded: 0,
      matched: 15,
    });
    expect(blocksMatchedStore.get()).toMatchObject({
      downloaded: 0,
      matched: 15,
      at: 1,
      percent: 0,
      etaMs: null,
    });

    tui.stop();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tui-blocks-matched.test.ts`  
Expected: FAIL (seed/`applyEvent` missing `at`, or empty snapshot shape)

- [ ] **Step 3: Pass `at` in tui-module + update hook empty**

In `src/tui/tui-module.ts`, change the seed call to:

```ts
blocksMatchedStore.applyEvent({
  at: Date.now(),
  downloaded: ctx.db.blocks.count(),
  matched: ctx.db.matchedBlocks.count(),
});
```

And the bus handler to:

```ts
ctx.bus.on("blocks:progress", (p) => {
  blocksMatchedStore.applyEvent({
    at: p.at,
    downloaded: p.downloaded,
    matched: p.matched,
  });
}),
```

In `src/tui/use-blocks-matched.ts`, update the empty snapshot:

```ts
const empty: BlocksProgress = {
  downloaded: 0,
  matched: 0,
  at: null,
  etaMs: null,
  percent: 0,
};
```

- [ ] **Step 4: Run tests**

Run: `bun test tests/tui-blocks-matched.test.ts tests/blocks-matched-store.test.ts`  
Expected: PASS

Also run: `bun test tests/tui-filters-progress.test.ts tests/tui-headers-progress.test.ts tests/tui-matching-progress.test.ts tests/tui-peer-count.test.ts`  
Expected: PASS (these construct `createBlocksMatchedStore()` but do not assert its snapshot shape)

- [ ] **Step 5: Commit** (skip unless user asks)

```bash
git add src/tui/tui-module.ts src/tui/use-blocks-matched.ts tests/tui-blocks-matched.test.ts
git commit -m "Pass blocks progress timestamps into the TUI store."
```

---

### Task 3: BlocksDownload tile UI

**Files:**
- Modify: `src/tui/components/BlocksDownload.tsx`

**Interfaces:**
- Consumes: `useBlocksProgress()` → `{ downloaded, matched, percent, etaMs }`
- Produces: tile layout identical to `FiltersDownload` (bar, counts, ETA when `percent < 100`)

- [ ] **Step 1: Update the component**

Replace `src/tui/components/BlocksDownload.tsx` with:

```tsx
import { formatEta, progressBar } from "../progress-format.ts";
import { useBlocksProgress } from "../use-blocks-matched.ts";

export function BlocksDownload() {
  const p = useBlocksProgress();
  return (
    <box
      title="Blocks download"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    >
      <text>{progressBar(p.percent)}</text>
      <text>
        {p.downloaded}/{p.matched}
      </text>
      {p.percent < 100 ? <text>ETA {formatEta(p.etaMs)}</text> : null}
    </box>
  );
}
```

- [ ] **Step 2: Typecheck / related tests**

Run: `bun test tests/blocks-matched-store.test.ts tests/tui-blocks-matched.test.ts`  
Expected: PASS

Run: `bunx tsc --noEmit` (or the repo’s usual typecheck if different)  
Expected: no errors related to `BlocksProgress` / `BlocksDownload`

If the repo has no standalone `tsc` script, run the full suite instead:

Run: `bun test`  
Expected: PASS

- [ ] **Step 3: Commit** (skip unless user asks)

```bash
git add src/tui/components/BlocksDownload.tsx
git commit -m "Show progress bar and ETA on the blocks download tile."
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Layout matches FiltersDownload | Task 3 |
| Sliding-window ETA (≥2 advancing samples) | Task 1 |
| Extend existing store (keep names) | Task 1 |
| Pass `at` from bus + seed | Task 2 |
| Reuse `progressBar` / `formatEta` | Task 3 |
| `setMatched` does not invent download samples | Task 1 |
| Done → `etaMs: 0`; hide ETA at 100% | Task 1 + Task 3 |
| Store + wiring tests | Task 1 + Task 2 |
| No download-module changes | (none) |
