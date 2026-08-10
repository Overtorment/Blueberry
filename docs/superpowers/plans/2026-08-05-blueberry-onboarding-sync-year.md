# blueberry Onboarding Sync-From-Year Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After wallet secret onboarding, let the user pick a checkpoint year (↑/↓ + Enter), persist `sync_from_year`, and start header sync with `consensusForYear(year)`.

**Architecture:** KV helpers in `src/sync-year.ts`. `OnboardingApp` becomes a two-step flow (secret → year `<select>`). Boot gate in `main` routes missing secret / missing year / ready. `createChainHeadersModule` gets `consensus: consensusForYear(year)`.

**Tech Stack:** Bun, TypeScript, React 19 + OpenTUI (`<select>`), existing `CHECKPOINTS` / `consensusForYear`, SQLite `key_value`.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-05-blueberry-onboarding-sync-year-design.md`.
- Prompt copy exactly: `What year was the first transaction for this wallet?`
- Years = all `CHECKPOINTS` keys, ascending; initial highlight `DEFAULT_CHECKPOINT_YEAR` (2019).
- KV key: `sync_from_year` = decimal year string (e.g. `"2019"`).
- Save secret on step 1; save year on step 2 confirm; then soft re-exec.
- Secret present + year missing/invalid → year-picker only.
- Invalid year in KV → treat as incomplete (picker), do not delete `wallet_secret`, do not hard-exit.
- Wire: `createChainHeadersModule(ctx, { net, consensus: consensusForYear(year) })`.
- No in-app year change after onboarding.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).

## File structure

| Path | Responsibility |
|------|----------------|
| `src/sync-year.ts` | KV key, list/parse/inspect/load/save year |
| `tests/sync-year.test.ts` | Helper unit tests |
| `src/tui/OnboardingApp.tsx` | Two-step secret + year UI |
| `tests/onboarding-app.test.ts` | Step transitions + year confirm callback (no full TUI harness) |
| `src/main.tsx` | Boot gate + persist callbacks + consensus wiring |

---

### Task 1: `sync-year` KV helpers

**Files:**
- Create: `src/sync-year.ts`
- Create: `tests/sync-year.test.ts`

**Interfaces:**
- Consumes: `CHECKPOINTS`, `DEFAULT_CHECKPOINT_YEAR` from `src/checkpoint.ts`; `KeyValueRepository`-shaped `{ keyValue: { get; set } }`
- Produces:
  - `SYNC_FROM_YEAR_KEY = "sync_from_year"`
  - `listCheckpointYears(): number[]` — `Object.keys(CHECKPOINTS).map(Number).sort((a,b)=>a-b)`
  - `parseSyncFromYear(raw: string | null): number | null` — trim; `Number.parseInt(trimmed, 10)`; must equal `String(year)` round-trip (reject `"2019.0"` / `"019"`); must be a key of `CHECKPOINTS`
  - `inspectSyncFromYear(db): { status: "missing" } | { status: "ok"; year: number }` — null/empty/invalid → `"missing"`
  - `loadSyncFromYear(db): number` — throws if inspect not ok
  - `saveSyncFromYear(db, year: number): void` — throws if year not in `CHECKPOINTS`; else `set(SYNC_FROM_YEAR_KEY, String(year))`

- [ ] **Step 1: Write failing tests**

Create `tests/sync-year.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { CHECKPOINTS, DEFAULT_CHECKPOINT_YEAR } from "../src/checkpoint.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import {
  SYNC_FROM_YEAR_KEY,
  inspectSyncFromYear,
  listCheckpointYears,
  loadSyncFromYear,
  parseSyncFromYear,
  saveSyncFromYear,
} from "../src/sync-year.ts";

describe("sync-year", () => {
  test("listCheckpointYears is sorted CHECKPOINTS keys", () => {
    const years = listCheckpointYears();
    expect(years[0]).toBe(2009);
    expect(years.at(-1)).toBe(2026);
    expect(years).toHaveLength(Object.keys(CHECKPOINTS).length);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    expect(years).toContain(DEFAULT_CHECKPOINT_YEAR);
  });

  test("parseSyncFromYear accepts only known year strings", () => {
    expect(parseSyncFromYear("2019")).toBe(2019);
    expect(parseSyncFromYear(" 2015 ")).toBe(2015);
    expect(parseSyncFromYear(null)).toBeNull();
    expect(parseSyncFromYear("")).toBeNull();
    expect(parseSyncFromYear("1999")).toBeNull();
    expect(parseSyncFromYear("2019.0")).toBeNull();
    expect(parseSyncFromYear("abc")).toBeNull();
  });

  test("inspect / save / load round-trip; invalid KV is missing", () => {
    const db = createSqliteDatabase(":memory:");
    expect(inspectSyncFromYear(db)).toEqual({ status: "missing" });
    expect(() => loadSyncFromYear(db)).toThrow(/sync_from_year/i);

    saveSyncFromYear(db, 2019);
    expect(db.keyValue.get(SYNC_FROM_YEAR_KEY)).toBe("2019");
    expect(inspectSyncFromYear(db)).toEqual({ status: "ok", year: 2019 });
    expect(loadSyncFromYear(db)).toBe(2019);

    db.keyValue.set(SYNC_FROM_YEAR_KEY, "nope");
    expect(inspectSyncFromYear(db)).toEqual({ status: "missing" });

    expect(() => saveSyncFromYear(db, 1999)).toThrow(/unknown/i);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/sync-year.test.ts`

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/sync-year.ts`**

```ts
import { CHECKPOINTS } from "./checkpoint.ts";

export const SYNC_FROM_YEAR_KEY = "sync_from_year";

type Kv = {
  keyValue: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
};

export function listCheckpointYears(): number[] {
  return Object.keys(CHECKPOINTS)
    .map(Number)
    .sort((a, b) => a - b);
}

export function parseSyncFromYear(raw: string | null): number | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const year = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(year) || String(year) !== trimmed) return null;
  if (!(year in CHECKPOINTS)) return null;
  return year;
}

export type SyncFromYearInspection =
  | { status: "missing" }
  | { status: "ok"; year: number };

export function inspectSyncFromYear(db: Kv): SyncFromYearInspection {
  const year = parseSyncFromYear(db.keyValue.get(SYNC_FROM_YEAR_KEY));
  if (year === null) return { status: "missing" };
  return { status: "ok", year };
}

export function loadSyncFromYear(db: Kv): number {
  const inspected = inspectSyncFromYear(db);
  if (inspected.status !== "ok") {
    throw new Error("sync_from_year missing or invalid");
  }
  return inspected.year;
}

export function saveSyncFromYear(db: Kv, year: number): void {
  if (!(year in CHECKPOINTS)) {
    throw new Error(`unknown sync_from_year: ${year}`);
  }
  db.keyValue.set(SYNC_FROM_YEAR_KEY, String(year));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/sync-year.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/sync-year.ts tests/sync-year.test.ts
git commit -m "$(cat <<'EOF'
Add sync_from_year key_value helpers.

EOF
)"
```

---

### Task 2: Two-step `OnboardingApp` (secret → year)

**Files:**
- Modify: `src/tui/OnboardingApp.tsx`
- Create: `tests/onboarding-app.test.ts`

**Interfaces:**
- Consumes: `parseWalletSecret`, `listCheckpointYears`, `DEFAULT_CHECKPOINT_YEAR`, OpenTUI `<select>` (`onSelect` = Enter confirm), `BlueberryArt`, `Panel`, `THEME`
- Produces:
  - `OnboardingAppProps = { startAtYearStep?: boolean; onSecretValidated: (raw: string) => void; onYearChosen: (year: number) => void }`
  - Step 1 valid Enter → `onSecretValidated(raw)` then local step = `"year"` (parent persists secret; **no** re-exec yet)
  - Step 2 Enter/`onSelect` → `onYearChosen(year)` once (parent persists year + re-exec)
  - `startAtYearStep: true` → render year step immediately

- [ ] **Step 1: Write failing tests for step callbacks**

Prefer testing via a tiny exported helper used by the component (keep UI thin). Create `src/tui/onboarding-flow.ts` in Step 3 if needed; tests may import it.

Create `tests/onboarding-app.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_CHECKPOINT_YEAR } from "../src/checkpoint.ts";
import {
  initialOnboardingStep,
  yearOptions,
  defaultYearSelectedIndex,
} from "../src/tui/onboarding-flow.ts";

describe("onboarding-flow", () => {
  test("startAtYearStep selects year step; otherwise secret", () => {
    expect(initialOnboardingStep(false)).toBe("secret");
    expect(initialOnboardingStep(true)).toBe("year");
  });

  test("yearOptions cover checkpoints and default index is 2019", () => {
    const opts = yearOptions();
    expect(opts[0]!.value).toBe(2009);
    expect(opts.at(-1)!.value).toBe(2026);
    expect(opts.every((o) => o.name === String(o.value))).toBe(true);
    expect(opts[defaultYearSelectedIndex()]!.value).toBe(DEFAULT_CHECKPOINT_YEAR);
  });
});
```

Also add a React-level smoke only if the repo already has a pattern for rendering OpenTUI components in tests; otherwise the flow helpers + Task 3 boot wiring are enough. Do **not** invent a heavy TUI harness.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/onboarding-app.test.ts`

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `onboarding-flow.ts` + rewrite `OnboardingApp.tsx`**

Create `src/tui/onboarding-flow.ts`:

```ts
import type { SelectOption } from "@opentui/core";
import { DEFAULT_CHECKPOINT_YEAR } from "../checkpoint.ts";
import { listCheckpointYears } from "../sync-year.ts";

export type OnboardingStep = "secret" | "year";

export function initialOnboardingStep(startAtYearStep: boolean): OnboardingStep {
  return startAtYearStep ? "year" : "secret";
}

export function yearOptions(): SelectOption[] {
  return listCheckpointYears().map((year) => ({
    name: String(year),
    description: "",
    value: year,
  }));
}

export function defaultYearSelectedIndex(): number {
  const years = listCheckpointYears();
  const idx = years.indexOf(DEFAULT_CHECKPOINT_YEAR);
  return idx >= 0 ? idx : 0;
}
```

Replace `src/tui/OnboardingApp.tsx` with:

```tsx
import { useMemo, useState } from "react";
import { BlueberryArt } from "./components/BlueberryArt.tsx";
import { Panel } from "./chrome.tsx";
import { THEME } from "./theme.ts";
import { parseWalletSecret } from "../wallet/secret.ts";
import {
  defaultYearSelectedIndex,
  initialOnboardingStep,
  yearOptions,
  type OnboardingStep,
} from "./onboarding-flow.ts";

export type OnboardingAppProps = {
  /** Secret already in KV — skip wallet step. */
  startAtYearStep?: boolean;
  onSecretValidated: (raw: string) => void;
  onYearChosen: (year: number) => void;
};

export function OnboardingApp({
  startAtYearStep = false,
  onSecretValidated,
  onYearChosen,
}: OnboardingAppProps) {
  const [step, setStep] = useState<OnboardingStep>(() =>
    initialOnboardingStep(startAtYearStep),
  );
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const options = useMemo(() => yearOptions(), []);
  const [selectedIndex, setSelectedIndex] = useState(defaultYearSelectedIndex);

  function submitSecret(raw: string) {
    if (busy) return;
    try {
      parseWalletSecret(raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setError(null);
    onSecretValidated(raw);
    setStep("year");
  }

  function confirmYear(index: number) {
    if (busy) return;
    const option = options[index];
    const year = option?.value;
    if (typeof year !== "number") return;
    setBusy(true);
    onYearChosen(year);
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={1}
      padding={1}
      backgroundColor={THEME.bg}
    >
      <box width="100%" height={7} flexGrow={0}>
        <BlueberryArt />
      </box>

      {step === "secret" ? (
        <box width="80%" height={8} flexGrow={0}>
          <Panel title="Wallet" state="active" accent="magenta" height="100%">
            <text fg={THEME.fgDim}>Enter BIP39 seed or account zpub</text>
            <input
              focused
              value={value}
              placeholder="seed words or zpub…"
              onInput={(v) => {
                setValue(v);
                if (error) setError(null);
              }}
              onSubmit={() => submitSecret(value)}
            />
            <text fg={error ? THEME.accentMagenta : THEME.fgDim}>
              {error ?? "Press Enter to continue"}
            </text>
          </Panel>
        </box>
      ) : (
        <box width="80%" height={16} flexGrow={0}>
          <Panel title="Sync from" state="active" accent="magenta" height="100%">
            <text fg={THEME.fgDim}>
              What year was the first transaction for this wallet?
            </text>
            <select
              focused={!busy}
              options={options}
              selectedIndex={selectedIndex}
              showDescription={false}
              showScrollIndicator
              height={10}
              onChange={(index) => setSelectedIndex(index)}
              onSelect={(index) => confirmYear(index)}
            />
            <text fg={THEME.fgDim}>
              {busy ? "Saving…" : "↑/↓ to choose · Enter to confirm"}
            </text>
          </Panel>
        </box>
      )}
    </box>
  );
}
```

If `<select>` prop names differ slightly in this OpenTUI version, match `@opentui/react` `SelectProps` (`onSelect` / `onChange` / `showDescription`).

- [ ] **Step 4: Run tests**

Run: `bun test tests/onboarding-app.test.ts tests/sync-year.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/tui/OnboardingApp.tsx src/tui/onboarding-flow.ts tests/onboarding-app.test.ts
git commit -m "$(cat <<'EOF'
Add onboarding year picker step after wallet secret.

EOF
)"
```

---

### Task 3: Boot gate + `chain-headers` consensus wiring

**Files:**
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `inspectWalletSecret`, `saveWalletSecret`, `inspectSyncFromYear`, `saveSyncFromYear`, `loadSyncFromYear`, `consensusForYear`, `OnboardingApp`
- Produces: boot routing per spec table; onboarding finish re-exec only after year saved

- [ ] **Step 1: Rewrite onboarding / boot branch in `main.tsx`**

Replace the current `walletSecret.status === "missing"` block and `else { await startApp(db) }` with logic equivalent to:

```ts
import { consensusForYear } from "./checkpoint.ts";
import {
  inspectSyncFromYear,
  loadSyncFromYear,
  saveSyncFromYear,
} from "./sync-year.ts";

// after inspectWalletSecret invalid → exit (unchanged)

const syncYear = inspectSyncFromYear(db);
const needsSecret = walletSecret.status === "missing";
const needsYear =
  walletSecret.status === "ok" && syncYear.status === "missing";

if (needsSecret || needsYear) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
  });

  function quitOnboarding(code: number, err?: unknown): void {
    try {
      renderer.destroy();
    } catch {
      /* ignore */
    }
    if (err !== undefined) console.error(err);
    process.reallyExit(code);
  }

  function finishOnboarding(): void {
    try {
      root.unmount();
    } catch {
      /* ignore */
    }
    try {
      renderer.destroy();
    } catch {
      /* ignore */
    }
    try {
      db.close();
    } catch {
      /* ignore */
    }
    reexecSelf();
  }

  const root = createRoot(renderer);
  root.render(
    <OnboardingApp
      startAtYearStep={needsYear}
      onSecretValidated={(raw) => {
        try {
          saveWalletSecret(db, raw);
        } catch (err) {
          quitOnboarding(1, err);
        }
      }}
      onYearChosen={(year) => {
        try {
          saveSyncFromYear(db, year);
        } catch (err) {
          quitOnboarding(1, err);
          return;
        }
        finishOnboarding();
      }}
    />,
  );

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") quitOnboarding(0);
  });
  process.once("SIGINT", () => quitOnboarding(0));
  process.once("SIGTERM", () => quitOnboarding(0));
} else {
  await startApp(db);
}
```

In `startApp`, change chain-headers construction to:

```ts
const year = loadSyncFromYear(db);
// ...
createChainHeadersModule(ctx, {
  net,
  consensus: consensusForYear(year),
}),
```

Do not start the app if year is missing — the gate above must have caught it. `loadSyncFromYear` is a safety throw.

- [ ] **Step 2: Run focused + related suites**

Run:

```bash
bun test tests/sync-year.test.ts tests/onboarding-app.test.ts tests/checkpoint.test.ts tests/chain-headers.test.ts
```

Expected: PASS (`chain-headers` tests still pass their own `consensus` / default).

- [ ] **Step 3: Full suite**

Run: `bun test`

Expected: PASS

- [ ] **Step 4: Manual smoke (implementer notes in report)**

1. Wipe or use empty `data/blueberry.sqlite`.
2. Run app → enter abandon mnemonic → year list appears (2019 highlighted).
3. Arrow to another year, Enter → app starts; headers tip progress from that checkpoint height.
4. Kill mid-year-step after secret saved → restart shows year step only.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/main.tsx src/sync-year.ts src/tui/OnboardingApp.tsx src/tui/onboarding-flow.ts tests/sync-year.test.ts tests/onboarding-app.test.ts
git commit -m "$(cat <<'EOF'
Gate onboarding on sync_from_year and wire header consensus.

EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Prompt copy | 2 |
| Year list + default 2019 highlight | 1–2 |
| `<select>` ↑/↓ Enter | 2 |
| `sync_from_year` KV | 1, 3 |
| Secret then year then re-exec | 2–3 |
| Year-only resume | 3 |
| Invalid year → picker | 1, 3 |
| `consensusForYear` in chain-headers | 3 |
| Helper + flow tests | 1–2 |
| No post-onboarding year change | all (no UI) |
