# blueberry TUI Cyberpunk Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle and restack the OpenTUI dashboard into a neon cyberpunk, wallet-first console with full-theater motion, using only the xterm 256-color palette so colors stay intact inside GNU `screen`.

**Architecture:** Add a central 256-index theme, shared panel chrome, richer progress-bar formatting with theater frames, and a tick hook. Restack `App` to sync-strip → Balance banner → Transactions. Domain stores, bus events, and module start order stay unchanged.

**Tech Stack:** Bun, TypeScript, React 19, `@opentui/core` / `@opentui/react` `RGBA.fromIndex`. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-03-blueberry-tui-cyberpunk-design.md`.
- Colors only via `RGBA.fromIndex(n)` (intent `indexed`); never free truecolor hex for theme tokens.
- Accent pairing: cyan chrome + magenta wallet; done = bright green; idle = dim grey.
- Layout: sync strip (5 tiles) → Balance banner → Transactions (`flexGrow`).
- Motion: title pulse + bar tip blink + scan on active sync bars; idle/done quiet.
- Domain logic, bus shapes, ETA algorithms, `main.tsx` start order: unchanged.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).

## File structure

| Path | Responsibility |
|------|----------------|
| `src/tui/theme.ts` | ansi256 role tokens + accent helpers |
| `src/tui/panel-state.ts` | Derive idle/active/done from progress/status/peers |
| `src/tui/progress-format.ts` | Block bars + tip/scan frames; keep `formatEta` |
| `src/tui/use-theater.ts` | ~300ms tick → pulse/tip/scan frame values |
| `src/tui/chrome.tsx` | Shared bordered titled panel |
| `src/tui/App.tsx` | Strip + stacked stage layout |
| `src/tui/components/*.tsx` | Consume chrome/theme/theater; same hooks |
| `tests/tui-theme.test.ts` | Tokens are indexed 256 colors |
| `tests/tui-panel-state.test.ts` | State derivation rules |
| `tests/tui-progress-format.test.ts` | Bar width / 0% / 100% / tip / scan |

---

### Task 1: Theme (256-index tokens)

**Files:**
- Create: `src/tui/theme.ts`
- Create: `tests/tui-theme.test.ts`

**Interfaces:**
- Consumes: `RGBA` from `@opentui/core`
- Produces:

```ts
import { RGBA } from "@opentui/core";

export const THEME = {
  bg: RGBA.fromIndex(234),
  fg: RGBA.fromIndex(252),
  fgDim: RGBA.fromIndex(240),
  accentCyan: RGBA.fromIndex(51),
  accentMagenta: RGBA.fromIndex(201),
  done: RGBA.fromIndex(46),
  borderIdle: RGBA.fromIndex(238),
} as const;

export type PanelAccent = "cyan" | "magenta";

export function accentColor(accent: PanelAccent): RGBA;
export function borderColorFor(
  state: "idle" | "active" | "done",
  accent: PanelAccent,
): RGBA;
export function titleColorFor(
  state: "idle" | "active" | "done",
  accent: PanelAccent,
  pulseOn: boolean,
): RGBA;
```

- [ ] **Step 1: Write the failing theme test**

Create `tests/tui-theme.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  THEME,
  accentColor,
  borderColorFor,
  titleColorFor,
} from "../src/tui/theme.ts";

describe("tui theme", () => {
  test("all role tokens are ansi256 indexed colors", () => {
    for (const [name, color] of Object.entries(THEME)) {
      expect(color.intent, name).toBe("indexed");
      expect(color.slot, name).toBeGreaterThanOrEqual(0);
      expect(color.slot, name).toBeLessThanOrEqual(255);
    }
  });

  test("border and title colors follow state rules", () => {
    expect(borderColorFor("idle", "cyan").slot).toBe(THEME.borderIdle.slot);
    expect(borderColorFor("active", "cyan").slot).toBe(THEME.accentCyan.slot);
    expect(borderColorFor("done", "magenta").slot).toBe(THEME.done.slot);

    expect(titleColorFor("idle", "cyan", true).slot).toBe(THEME.fgDim.slot);
    expect(titleColorFor("active", "magenta", true).slot).toBe(
      THEME.accentMagenta.slot,
    );
    expect(titleColorFor("active", "magenta", false).slot).toBe(
      THEME.fgDim.slot,
    );
    expect(titleColorFor("done", "cyan", true).slot).toBe(THEME.done.slot);
  });

  test("accentColor maps cyan/magenta", () => {
    expect(accentColor("cyan").slot).toBe(THEME.accentCyan.slot);
    expect(accentColor("magenta").slot).toBe(THEME.accentMagenta.slot);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tui-theme.test.ts`  
Expected: FAIL (module not found / export missing)

- [ ] **Step 3: Implement theme**

Create `src/tui/theme.ts`:

```ts
import { RGBA } from "@opentui/core";

export const THEME = {
  bg: RGBA.fromIndex(234),
  fg: RGBA.fromIndex(252),
  fgDim: RGBA.fromIndex(240),
  accentCyan: RGBA.fromIndex(51),
  accentMagenta: RGBA.fromIndex(201),
  done: RGBA.fromIndex(46),
  borderIdle: RGBA.fromIndex(238),
} as const;

export type PanelAccent = "cyan" | "magenta";
export type PanelVisualState = "idle" | "active" | "done";

export function accentColor(accent: PanelAccent): RGBA {
  return accent === "cyan" ? THEME.accentCyan : THEME.accentMagenta;
}

export function borderColorFor(
  state: PanelVisualState,
  accent: PanelAccent,
): RGBA {
  if (state === "done") return THEME.done;
  if (state === "active") return accentColor(accent);
  return THEME.borderIdle;
}

export function titleColorFor(
  state: PanelVisualState,
  accent: PanelAccent,
  pulseOn: boolean,
): RGBA {
  if (state === "done") return THEME.done;
  if (state === "idle") return THEME.fgDim;
  return pulseOn ? accentColor(accent) : THEME.fgDim;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tui-theme.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/tui/theme.ts tests/tui-theme.test.ts
git commit -m "Add 256-index cyberpunk TUI theme tokens."
```

---

### Task 2: Panel state helpers

**Files:**
- Create: `src/tui/panel-state.ts`
- Create: `tests/tui-panel-state.test.ts`

**Interfaces:**
- Consumes: none
- Produces:

```ts
export type PanelVisualState = "idle" | "active" | "done";

export function progressPanelState(percent: number): PanelVisualState;
export function peersPanelState(count: number): PanelVisualState;
export function statusPanelState(status: string): PanelVisualState;
```

Note: re-export or share `PanelVisualState` with `theme.ts` — keep the type defined once in `theme.ts` and import it in `panel-state.ts` (or define in `panel-state.ts` and import in theme). Prefer defining in `panel-state.ts` and importing into `theme.ts` if that avoids circular imports; simplest: define the union in `theme.ts` (already above) and import it here.

- [ ] **Step 1: Write the failing panel-state test**

Create `tests/tui-panel-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  peersPanelState,
  progressPanelState,
  statusPanelState,
} from "../src/tui/panel-state.ts";

describe("panel state", () => {
  test("progress tiles", () => {
    expect(progressPanelState(0)).toBe("idle");
    expect(progressPanelState(-1)).toBe("idle");
    expect(progressPanelState(1)).toBe("active");
    expect(progressPanelState(99)).toBe("active");
    expect(progressPanelState(100)).toBe("done");
  });

  test("peers", () => {
    expect(peersPanelState(0)).toBe("idle");
    expect(peersPanelState(3)).toBe("active");
  });

  test("status panels", () => {
    expect(statusPanelState("idle")).toBe("idle");
    expect(statusPanelState("…")).toBe("idle");
    expect(statusPanelState("")).toBe("idle");
    expect(statusPanelState("running")).toBe("active");
    expect(statusPanelState("starting")).toBe("active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tui-panel-state.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement panel-state**

Create `src/tui/panel-state.ts`:

```ts
import type { PanelVisualState } from "./theme.ts";

export type { PanelVisualState };

export function progressPanelState(percent: number): PanelVisualState {
  if (percent >= 100) return "done";
  if (percent > 0) return "active";
  return "idle";
}

export function peersPanelState(count: number): PanelVisualState {
  return count > 0 ? "active" : "idle";
}

export function statusPanelState(status: string): PanelVisualState {
  if (status === "" || status === "idle" || status === "…") return "idle";
  return "active";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tui-panel-state.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/tui/panel-state.ts tests/tui-panel-state.test.ts
git commit -m "Add TUI panel idle/active/done helpers."
```

---

### Task 3: Progress format (block bars + tip/scan)

**Files:**
- Modify: `src/tui/progress-format.ts`
- Create: `tests/tui-progress-format.test.ts`

**Interfaces:**
- Consumes: none
- Produces:

```ts
export function formatEta(etaMs: number | null): string;

export type ProgressBarOptions = {
  tipOn?: boolean;
  scanOffset?: number; // 0..filled-1 when filled > 0
};

export function progressBar(
  percent: number,
  width?: number,
  opts?: ProgressBarOptions,
): string;
```

Bar alphabet: fill `█`, empty `░`, tip glyph `▸` (shown when `tipOn` and `0 < percent < 100`), scan: when `scanOffset` is set and filled > 0, replace the cell at `scanOffset % filled` with `▓`.

Keep `formatEta` behavior identical to today.

- [ ] **Step 1: Write the failing progress-format test**

Create `tests/tui-progress-format.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatEta, progressBar } from "../src/tui/progress-format.ts";

describe("progress format", () => {
  test("formatEta unchanged", () => {
    expect(formatEta(null)).toBe("—");
    expect(formatEta(0)).toBe("done");
    expect(formatEta(1500)).toBe("2s");
    expect(formatEta(65_000)).toBe("1m 5s");
  });

  test("0% and 100% bars", () => {
    expect(progressBar(0, 10)).toBe("[░░░░░░░░░░] 0%");
    expect(progressBar(100, 10)).toBe("[██████████] 100%");
  });

  test("mid bar with tip and scan", () => {
    const base = progressBar(50, 10);
    expect(base).toBe("[█████░░░░░] 50%");

    expect(progressBar(50, 10, { tipOn: true })).toBe("[█████▸░░░░] 50%");
    // tip replaces first empty; scan replaces fill cell 0
    expect(progressBar(50, 10, { tipOn: false, scanOffset: 0 })).toBe(
      "[▓████░░░░░] 50%",
    );
    expect(progressBar(50, 10, { tipOn: true, scanOffset: 2 })).toBe(
      "[██▓██▸░░░░] 50%",
    );
  });

  test("tip omitted at 0 and 100", () => {
    expect(progressBar(0, 10, { tipOn: true })).toBe("[░░░░░░░░░░] 0%");
    expect(progressBar(100, 10, { tipOn: true })).toBe("[██████████] 100%");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tui-progress-format.test.ts`  
Expected: FAIL (old `#`/`-` bar format)

- [ ] **Step 3: Implement progress-format**

Replace `src/tui/progress-format.ts` with:

```ts
export function formatEta(etaMs: number | null): string {
  if (etaMs === null) return "—";
  if (etaMs <= 0) return "done";
  const s = Math.round(etaMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

export type ProgressBarOptions = {
  tipOn?: boolean;
  scanOffset?: number;
};

export function progressBar(
  percent: number,
  width = 20,
  opts: ProgressBarOptions = {},
): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const cells = Array.from({ length: width }, (_, i) =>
    i < filled ? "█" : "░",
  );

  if (
    opts.scanOffset !== undefined &&
    filled > 0 &&
    clamped < 100
  ) {
    const idx = ((opts.scanOffset % filled) + filled) % filled;
    cells[idx] = "▓";
  }

  if (opts.tipOn && clamped > 0 && clamped < 100 && filled < width) {
    cells[filled] = "▸";
  }

  return `[${cells.join("")}] ${clamped}%`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tui-progress-format.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/tui/progress-format.ts tests/tui-progress-format.test.ts
git commit -m "Upgrade TUI progress bars with tip and scan frames."
```

---

### Task 4: Theater tick hook

**Files:**
- Create: `src/tui/use-theater.ts`
- Create: `tests/tui-theater.test.ts` (pure helpers only — no React DOM)

**Interfaces:**
- Consumes: none
- Produces:

```ts
export type TheaterFrame = {
  pulseOn: boolean;
  tipOn: boolean;
  scanOffset: number;
};

export function theaterFrameFromTick(tick: number): TheaterFrame;
// pulseOn = tick % 2 === 0
// tipOn = tick % 2 === 0
// scanOffset = tick % 32

export function useTheater(enabled: boolean): TheaterFrame;
// when enabled: setInterval 300ms, increment tick
// when disabled: return { pulseOn: false, tipOn: false, scanOffset: 0 }
```

- [ ] **Step 1: Write the failing theater helper test**

Create `tests/tui-theater.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { theaterFrameFromTick } from "../src/tui/use-theater.ts";

describe("theaterFrameFromTick", () => {
  test("even ticks pulse/tip on; scan advances", () => {
    expect(theaterFrameFromTick(0)).toEqual({
      pulseOn: true,
      tipOn: true,
      scanOffset: 0,
    });
    expect(theaterFrameFromTick(1)).toEqual({
      pulseOn: false,
      tipOn: false,
      scanOffset: 1,
    });
    expect(theaterFrameFromTick(32).scanOffset).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tui-theater.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement use-theater**

Create `src/tui/use-theater.ts`:

```ts
import { useEffect, useState } from "react";

export type TheaterFrame = {
  pulseOn: boolean;
  tipOn: boolean;
  scanOffset: number;
};

export function theaterFrameFromTick(tick: number): TheaterFrame {
  return {
    pulseOn: tick % 2 === 0,
    tipOn: tick % 2 === 0,
    scanOffset: ((tick % 32) + 32) % 32,
  };
}

const QUIET: TheaterFrame = {
  pulseOn: false,
  tipOn: false,
  scanOffset: 0,
};

export function useTheater(enabled: boolean): TheaterFrame {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), 300);
    return () => clearInterval(id);
  }, [enabled]);

  if (!enabled) return QUIET;
  return theaterFrameFromTick(tick);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tui-theater.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit** (only if user asked)

```bash
git add src/tui/use-theater.ts tests/tui-theater.test.ts
git commit -m "Add TUI theater tick hook."
```

---

### Task 5: Shared panel chrome

**Files:**
- Create: `src/tui/chrome.tsx`

**Interfaces:**
- Consumes: `THEME`, `borderColorFor`, `titleColorFor`, `PanelAccent` from `theme.ts`; `PanelVisualState` from `theme.ts`
- Produces:

```tsx
export type PanelProps = {
  title: string;
  state: PanelVisualState;
  accent: PanelAccent;
  pulseOn?: boolean;
  flexGrow?: number;
  height?: number | string;
  children: React.ReactNode;
};

export function Panel(props: PanelProps): JSX.Element;
// Renders bordered box:
// - title=`◆ ${title}` (or with pulse space)
// - borderStyle="double" when active/done, "single" when idle
// - borderColor / titleColor from theme helpers
// - backgroundColor=THEME.bg
// - padding={1}, flexDirection="column", height="100%" default
```

- [ ] **Step 1: Implement chrome**

Create `src/tui/chrome.tsx`:

```tsx
import type { ReactNode } from "react";
import {
  borderColorFor,
  THEME,
  titleColorFor,
  type PanelAccent,
  type PanelVisualState,
} from "./theme.ts";

export type PanelProps = {
  title: string;
  state: PanelVisualState;
  accent: PanelAccent;
  pulseOn?: boolean;
  flexGrow?: number;
  height?: number | string;
  children: ReactNode;
};

export function Panel({
  title,
  state,
  accent,
  pulseOn = false,
  flexGrow = 1,
  height = "100%",
  children,
}: PanelProps) {
  const borderColor = borderColorFor(state, accent);
  const titleColor = titleColorFor(state, accent, pulseOn);
  return (
    <box
      title={`◆ ${title}`}
      titleColor={titleColor}
      border
      borderStyle={state === "idle" ? "single" : "double"}
      borderColor={borderColor}
      backgroundColor={THEME.bg}
      flexGrow={flexGrow}
      height={height}
      flexDirection="column"
      padding={1}
    >
      {children}
    </box>
  );
}
```

- [ ] **Step 2: Typecheck chrome**

Run: `bun run typecheck`  
Expected: PASS (or only pre-existing unrelated errors)

- [ ] **Step 3: Commit** (only if user asked)

```bash
git add src/tui/chrome.tsx
git commit -m "Add shared cyberpunk TUI panel chrome."
```

---

### Task 6: Restack App + restyle all tiles

**Files:**
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/components/Balance.tsx`
- Modify: `src/tui/components/Peers.tsx`
- Modify: `src/tui/components/ChainTipSync.tsx`
- Modify: `src/tui/components/FiltersDownload.tsx`
- Modify: `src/tui/components/FiltersMatching.tsx`
- Modify: `src/tui/components/BlocksDownload.tsx`
- Modify: `src/tui/components/Transactions.tsx`

**Interfaces:**
- Consumes: `Panel` from `chrome.tsx`; `useTheater` from `use-theater.ts`; `progressBar`/`formatEta`; panel-state helpers; `THEME`
- Produces: stacked wallet-first layout with neon strip

Strip accents (alternating): Peers cyan, Chain magenta, Filters DL cyan, Matching magenta, Blocks cyan.  
Balance accent magenta. Transactions accent cyan.

Strip row height: `6`. Balance banner height: `5`. Transactions: `flexGrow={1}`.

Compact bar width in strip: `10`.

- [ ] **Step 1: Rewrite App layout**

Replace `src/tui/App.tsx` with:

```tsx
import { Balance } from "./components/Balance.tsx";
import { BlocksDownload } from "./components/BlocksDownload.tsx";
import { ChainTipSync } from "./components/ChainTipSync.tsx";
import { FiltersDownload } from "./components/FiltersDownload.tsx";
import { FiltersMatching } from "./components/FiltersMatching.tsx";
import { Peers } from "./components/Peers.tsx";
import { Transactions } from "./components/Transactions.tsx";
import { THEME } from "./theme.ts";

const STRIP_HEIGHT = 6;
const BALANCE_HEIGHT = 5;

export function App() {
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      padding={1}
      backgroundColor={THEME.bg}
    >
      <box
        width="100%"
        height={STRIP_HEIGHT}
        flexDirection="row"
        flexGrow={0}
        gap={1}
      >
        <Peers />
        <ChainTipSync />
        <FiltersDownload />
        <FiltersMatching />
        <BlocksDownload />
      </box>

      <box
        width="100%"
        height={BALANCE_HEIGHT}
        flexDirection="row"
        flexGrow={0}
      >
        <Balance />
      </box>

      <box width="100%" flexDirection="row" flexGrow={1} gap={1}>
        <Transactions />
      </box>
    </box>
  );
}
```

- [ ] **Step 2: Restyle progress strip tiles**

Each of `ChainTipSync`, `FiltersDownload`, `FiltersMatching`, `BlocksDownload` should follow this pattern (shown for Chain tip; adapt titles/hooks/count labels/accents):

```tsx
import { Panel } from "../chrome.tsx";
import { progressPanelState } from "../panel-state.ts";
import { formatEta, progressBar } from "../progress-format.ts";
import { THEME } from "../theme.ts";
import { useTheater } from "../use-theater.ts";
import { useHeadersProgress } from "../use-headers-progress.ts";

export function ChainTipSync() {
  const p = useHeadersProgress();
  const state = progressPanelState(p.percent);
  const theater = useTheater(state === "active");
  return (
    <Panel title="Chain tip" state={state} accent="magenta" pulseOn={theater.pulseOn}>
      <text fg={THEME.fg}>
        {progressBar(p.percent, 10, {
          tipOn: theater.tipOn,
          scanOffset: theater.scanOffset,
        })}
      </text>
      <text fg={THEME.fgDim}>
        {p.downloaded}/{p.total}
      </text>
      {p.percent < 100 ? (
        <text fg={THEME.fgDim}>ETA {formatEta(p.etaMs)}</text>
      ) : null}
    </Panel>
  );
}
```

Apply the same pattern to:

| Component | Title | Accent | Hook | Counts line |
|-----------|-------|--------|------|-------------|
| `FiltersDownload` | `Filters DL` | cyan | `useFiltersProgress` | `downloaded/total` |
| `FiltersMatching` | `Matching` | magenta | `useMatchingProgress` | `matched/total` (+ existing ETA `…` fallback) |
| `BlocksDownload` | `Blocks` | cyan | `useBlocksProgress` | `downloaded/matched` |

Preserve FiltersMatching ETA fallback logic exactly:

```ts
const eta =
  p.etaMs !== null
    ? formatEta(p.etaMs)
    : p.total > 0 && p.matched < p.total
      ? "…"
      : formatEta(null);
```

- [ ] **Step 3: Restyle Peers, Balance, Transactions**

`Peers.tsx`:

```tsx
import { Panel } from "../chrome.tsx";
import { peersPanelState } from "../panel-state.ts";
import { THEME } from "../theme.ts";
import { useTheater } from "../use-theater.ts";
import { usePeerCount } from "../use-peer-count.ts";

export function Peers() {
  const count = usePeerCount();
  const state = peersPanelState(count);
  const theater = useTheater(state === "active");
  return (
    <Panel title="Peers" state={state} accent="cyan" pulseOn={theater.pulseOn}>
      <text fg={THEME.fg}>{count} peers</text>
    </Panel>
  );
}
```

`Balance.tsx`:

```tsx
import { Panel } from "../chrome.tsx";
import { statusPanelState } from "../panel-state.ts";
import { THEME } from "../theme.ts";
import { useTheater } from "../use-theater.ts";
import { useModuleStatus } from "../use-module-status.ts";

export function Balance() {
  const status = useModuleStatus("balance");
  const state = statusPanelState(status);
  const theater = useTheater(state === "active");
  return (
    <Panel
      title="Balance"
      state={state}
      accent="magenta"
      pulseOn={theater.pulseOn}
    >
      <text fg={THEME.accentCyan}>{status}</text>
    </Panel>
  );
}
```

`Transactions.tsx`:

```tsx
import { Panel } from "../chrome.tsx";
import { statusPanelState } from "../panel-state.ts";
import { THEME } from "../theme.ts";
import { useTheater } from "../use-theater.ts";
import { useModuleStatus } from "../use-module-status.ts";

export function Transactions() {
  const status = useModuleStatus("parse-blocks");
  const state = statusPanelState(status);
  const theater = useTheater(state === "active");
  return (
    <Panel
      title="Transactions"
      state={state}
      accent="cyan"
      pulseOn={theater.pulseOn}
    >
      <text fg={THEME.fg}>{status}</text>
    </Panel>
  );
}
```

- [ ] **Step 4: Typecheck + full test suite**

Run:

```bash
bun run typecheck
bun test
```

Expected: typecheck clean; all tests PASS (including existing TUI store-wiring tests and new theme/panel/progress/theater tests).

- [ ] **Step 5: Manual smoke in screen**

Run: `bun start` (preferably inside `screen`)  
Verify:

1. Layout is strip → Balance → Transactions.
2. Cyan/magenta accents visible; no garbled truecolor.
3. Active progress tiles pulse/tip/scan; at 100% go green and quiet.
4. Ctrl+C still quits.

- [ ] **Step 6: Commit** (only if user asked)

```bash
git add src/tui/App.tsx src/tui/components
git commit -m "Restack TUI into cyberpunk strip + wallet stage."
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| 256-color theme tokens (cyan/magenta/done/dim) | Task 1 |
| Panel idle/active/done rules | Task 2 |
| Richer bars + tip/scan | Task 3 |
| Theater tick (pulse/tip/scan) | Task 4 |
| Shared chrome (`◆`, borders) | Task 5 |
| Strip + stacked Balance/Tx layout | Task 6 |
| Components restyled, hooks unchanged | Task 6 |
| Domain/bus/`main.tsx` untouched | (constraint — no task modifies them) |
| Unit tests for format + theme | Tasks 1, 3 (+ 2, 4) |
| `screen`-safe colors | Task 1 + Task 6 manual check |
| No truecolor / no mouse / no new wallet features | Global constraints |

## Self-review notes

- No TBD/placeholder steps.
- `PanelVisualState` lives in `theme.ts`; `panel-state.ts` imports it.
- Status idle includes `"idle"` (actual hook default), plus `"…"` / `""` from the spec.
- `progressBar` third-arg options are optional — existing call sites keep compiling until Task 6 updates them.
- Commit steps skipped unless the user asks, matching prior blueberry plans.
