# blueberry Year-Keyed Checkpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bake mainnet trusted checkpoints for years 2009–2026 into `src/checkpoint.ts` as a year-keyed map with helpers to build consensus/seed records, keeping sync wired to a default year (no UI yet).

**Architecture:** Inline `CHECKPOINTS` map in `src/checkpoint.ts` (data from `docs/superpowers/plans/assets/2026-08-05-year-checkpoints.json`). Each entry is a difficulty-period start at or before that year’s Jan 1 UTC. Helpers `checkpointForYear` / `consensusForYear` / optional-year seed helpers; legacy `CHECKPOINT_*` and `BLUEBERRY_HEADER_CONSENSUS` alias `DEFAULT_CHECKPOINT_YEAR = 2019` (height `556416`).

**Tech Stack:** Bun, TypeScript, `bitcoin-headers` (`HeaderConsensusParams`, `validateHeaderChain`).

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-05-blueberry-year-checkpoints-design.md` (including amendment: default year `2019` @ height `556416`, not retired `548352`).
- Keys `2009`…`2026`; `name === String(year)`.
- Height pick: highest `height % 2016 === 0` with block time ≤ `Y-01-01T00:00:00Z`; `2009` → genesis `0` with ten `0` prev timestamps.
- Data + helpers only; no onboarding UI; no persisted year choice.
- Do not fetch checkpoints at runtime — bake into `src/checkpoint.ts`.
- Source bake file: `docs/superpowers/plans/assets/2026-08-05-year-checkpoints.json` (already fetched from mempool.space).
- Commits: only when the user explicitly asks (skip Commit steps unless asked).

## File structure

| Path | Responsibility |
|------|----------------|
| `docs/superpowers/plans/assets/2026-08-05-year-checkpoints.json` | Baked hex/timestamps used to populate the TS map (reference only) |
| `src/checkpoint.ts` | `YearCheckpoint`, `CHECKPOINTS`, helpers, legacy aliases |
| `tests/checkpoint.test.ts` | Map coverage + PoW/hash + seed validation for sample years |
| `tests/chain-headers.test.ts` | Update real next-header fixture to height `556417` |

### Expected heights (verification table)

| Year | Height |
|------|--------|
| 2009 | 0 |
| 2010 | 32256 |
| 2011 | 98784 |
| 2012 | 159264 |
| 2013 | 213696 |
| 2014 | 276192 |
| 2015 | 336672 |
| 2016 | 391104 |
| 2017 | 445536 |
| 2018 | 499968 |
| 2019 | 556416 |
| 2020 | 608832 |
| 2021 | 663264 |
| 2022 | 715680 |
| 2023 | 768096 |
| 2024 | 822528 |
| 2025 | 876960 |
| 2026 | 929376 |

---

### Task 1: Failing checkpoint map tests

**Files:**
- Modify: `tests/checkpoint.test.ts`
- Modify: `src/checkpoint.ts` (only if needed for imports to resolve — prefer tests importing symbols that do not exist yet so they fail)

**Interfaces:**
- Consumes: (none yet — tests define the target API)
- Produces (expected API for Task 2):
  - `export type YearCheckpoint = { name: string; height: number; headerHex: string; displayHash: string; previousTimestamps: readonly number[] }`
  - `export const CHECKPOINTS: Readonly<Record<number, YearCheckpoint>>`
  - `export const DEFAULT_CHECKPOINT_YEAR = 2019`
  - `export function checkpointForYear(year: number): YearCheckpoint`
  - `export function consensusForYear(year: number): HeaderConsensusParams`
  - `export function checkpointDbRecord(year?: number): DbHeaderRecord`
  - `export function checkpointSeedRecord(year?: number): …` (same enriched shape as today)
  - Legacy: `CHECKPOINT_HEIGHT`, `CHECKPOINT_DISPLAY_HASH`, `CHECKPOINT_HEADER_HEX`, `CHECKPOINT_HEADER`, `PRE_CHECKPOINT_TIMESTAMPS`, `BLUEBERRY_HEADER_CONSENSUS` — all from default year

- [ ] **Step 1: Rewrite `tests/checkpoint.test.ts`**

Replace file contents with:

```ts
import { describe, expect, test } from "bun:test";
import {
  decodeBlockHeader,
  headerHashDisplay,
  headerHashInternal,
  meetsTarget,
  validateHeaderChain,
} from "bitcoin-headers";
import {
  CHECKPOINT_DISPLAY_HASH,
  CHECKPOINT_HEADER,
  CHECKPOINT_HEIGHT,
  CHECKPOINTS,
  DEFAULT_CHECKPOINT_YEAR,
  BLUEBERRY_HEADER_CONSENSUS,
  checkpointForYear,
  checkpointSeedRecord,
  consensusForYear,
} from "../src/checkpoint.ts";

const EXPECTED_HEIGHTS: Record<number, number> = {
  2009: 0,
  2010: 32_256,
  2011: 98_784,
  2012: 159_264,
  2013: 213_696,
  2014: 276_192,
  2015: 336_672,
  2016: 391_104,
  2017: 445_536,
  2018: 499_968,
  2019: 556_416,
  2020: 608_832,
  2021: 663_264,
  2022: 715_680,
  2023: 768_096,
  2024: 822_528,
  2025: 876_960,
  2026: 929_376,
};

describe("year checkpoints", () => {
  test("covers 2009–2026 with expected retarget heights", () => {
    const years = Object.keys(EXPECTED_HEIGHTS).map(Number);
    expect(years).toEqual(Object.keys(CHECKPOINTS).map(Number).sort((a, b) => a - b));
    for (const year of years) {
      const entry = CHECKPOINTS[year]!;
      expect(entry.name).toBe(String(year));
      expect(entry.height).toBe(EXPECTED_HEIGHTS[year]!);
      expect(entry.height % 2016).toBe(0);
      expect(entry.previousTimestamps).toHaveLength(10);
      expect(entry.headerHex).toHaveLength(160);
      const header = decodeBlockHeader(
        Uint8Array.from(
          entry.headerHex.match(/.{2}/g)!.map((b) => Number.parseInt(b, 16)),
        ),
      );
      expect(headerHashDisplay(header)).toBe(entry.displayHash);
      expect(meetsTarget(headerHashInternal(header), header.bits)).toBe(true);
    }
  });

  test("checkpointForYear / consensusForYear / unknown year", () => {
    expect(checkpointForYear(2015).height).toBe(336_672);
    expect(consensusForYear(2015).checkpoint.height).toBe(336_672);
    expect(() => checkpointForYear(1999)).toThrow(/unknown checkpoint year/i);
  });

  test("default year aliases match CHECKPOINTS[2019]", () => {
    expect(DEFAULT_CHECKPOINT_YEAR).toBe(2019);
    const d = CHECKPOINTS[2019]!;
    expect(CHECKPOINT_HEIGHT).toBe(d.height);
    expect(CHECKPOINT_HEIGHT).toBe(556_416);
    expect(CHECKPOINT_DISPLAY_HASH).toBe(d.displayHash);
    expect(BLUEBERRY_HEADER_CONSENSUS.checkpoint.height).toBe(d.height);
    const header = decodeBlockHeader(CHECKPOINT_HEADER);
    expect(headerHashDisplay(header)).toBe(CHECKPOINT_DISPLAY_HASH);
  });

  test("seed records validate for genesis, mid, and default years", () => {
    for (const year of [2009, 2015, 2019] as const) {
      const seed = checkpointSeedRecord(year);
      const chain = validateHeaderChain(
        [seed],
        consensusForYear(year),
        seed.header.timestamp + 60,
      );
      expect(chain.tipHeight).toBe(EXPECTED_HEIGHTS[year]!);
      expect(chain.tipHashDisplay).toBe(CHECKPOINTS[year]!.displayHash);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/checkpoint.test.ts`

Expected: FAIL (missing `CHECKPOINTS` / `DEFAULT_CHECKPOINT_YEAR` / `checkpointForYear` / `consensusForYear`, and/or `CHECKPOINT_HEIGHT` still `548352`).

- [ ] **Step 3: Commit (only if user asked)**

```bash
git add tests/checkpoint.test.ts
git commit -m "$(cat <<'EOF'
Test year-keyed checkpoint map API.

EOF
)"
```

---

### Task 2: Implement `CHECKPOINTS` map + helpers

**Files:**
- Modify: `src/checkpoint.ts`
- Read: `docs/superpowers/plans/assets/2026-08-05-year-checkpoints.json`

**Interfaces:**
- Consumes: JSON asset fields `{ name, height, displayHash, headerHex, previousTimestamps }` per year key
- Produces: full API from Task 1 Interfaces

- [ ] **Step 1: Generate the TypeScript map body from the JSON asset**

Run:

```bash
bun -e '
const raw = await Bun.file("docs/superpowers/plans/assets/2026-08-05-year-checkpoints.json").json();
const years = Object.keys(raw).map(Number).sort((a,b)=>a-b);
let body = "export const CHECKPOINTS: Readonly<Record<number, YearCheckpoint>> = Object.freeze({\n";
for (const y of years) {
  const e = raw[String(y)];
  body += `  ${y}: Object.freeze({\n`;
  body += `    name: ${JSON.stringify(e.name)},\n`;
  body += `    height: ${e.height},\n`;
  body += `    displayHash: ${JSON.stringify(e.displayHash)},\n`;
  body += `    headerHex: ${JSON.stringify(e.headerHex)},\n`;
  body += `    previousTimestamps: Object.freeze(${JSON.stringify(e.previousTimestamps)} as number[]),\n`;
  body += `  }),\n`;
}
body += "} as Record<number, YearCheckpoint>);\n";
await Bun.write("/tmp/checkpoints-map.tsfragment", body);
console.log("wrote", years.length, "entries");
'
```

- [ ] **Step 2: Replace `src/checkpoint.ts` with map + helpers**

Write `src/checkpoint.ts` as follows. Paste the generated `CHECKPOINTS` const from `/tmp/checkpoints-map.tsfragment` in place of the `CHECKPOINTS` placeholder comment.

```ts
import {
  bytesToHex,
  decodeBlockHeader,
  headerHashDisplay,
  headerHashInternal,
  hexToBytes,
  MAINNET_POW_LIMIT,
  meetsTarget,
  type HeaderConsensusParams,
  type HeaderRecord as LibHeaderRecord,
} from "bitcoin-headers";
import type { HeaderRecord as DbHeaderRecord } from "./db/types.ts";

export type YearCheckpoint = {
  name: string;
  height: number;
  headerHex: string;
  displayHash: string;
  previousTimestamps: readonly number[];
};

export const DEFAULT_CHECKPOINT_YEAR = 2019;

// PASTE generated CHECKPOINTS const here (from Step 1).

export function checkpointForYear(year: number): YearCheckpoint {
  const entry = CHECKPOINTS[year];
  if (!entry) {
    throw new Error(`unknown checkpoint year: ${year}`);
  }
  return entry;
}

function mainnetConsensus(checkpoint: YearCheckpoint): HeaderConsensusParams {
  return Object.freeze({
    powLimit: MAINNET_POW_LIMIT,
    targetSpacingSeconds: 10 * 60,
    targetTimespanSeconds: 14 * 24 * 60 * 60,
    retargetInterval: 2_016,
    medianTimeSpan: 11,
    maxFutureSeconds: 2 * 60 * 60,
    checkpoint: Object.freeze({
      height: checkpoint.height,
      headerBytes: hexToBytes(checkpoint.headerHex),
      hashDisplay: checkpoint.displayHash,
      previousTimestamps: checkpoint.previousTimestamps,
    }),
  });
}

export function consensusForYear(year: number): HeaderConsensusParams {
  return mainnetConsensus(checkpointForYear(year));
}

const DEFAULT = CHECKPOINTS[DEFAULT_CHECKPOINT_YEAR]!;

/** @deprecated Prefer CHECKPOINTS / checkpointForYear — aliases default year. */
export const CHECKPOINT_HEIGHT = DEFAULT.height;
export const CHECKPOINT_DISPLAY_HASH = DEFAULT.displayHash;
export const CHECKPOINT_HEADER_HEX = DEFAULT.headerHex;
export const CHECKPOINT_HEADER = hexToBytes(CHECKPOINT_HEADER_HEX);
export const PRE_CHECKPOINT_TIMESTAMPS = DEFAULT.previousTimestamps;

export const BLUEBERRY_HEADER_CONSENSUS: HeaderConsensusParams =
  consensusForYear(DEFAULT_CHECKPOINT_YEAR);

export function checkpointDbRecord(
  year: number = DEFAULT_CHECKPOINT_YEAR,
): DbHeaderRecord {
  const cp = checkpointForYear(year);
  const header = hexToBytes(cp.headerHex);
  return {
    height: cp.height,
    hashInternalHex: bytesToHex(headerHashInternal(decodeBlockHeader(header))),
    header: header.slice(),
  };
}

export function checkpointSeedRecord(year: number = DEFAULT_CHECKPOINT_YEAR): LibHeaderRecord & {
  header: ReturnType<typeof decodeBlockHeader>;
  hashInternal: Uint8Array;
} {
  const cp = checkpointForYear(year);
  const headerBytes = hexToBytes(cp.headerHex);
  const header = decodeBlockHeader(headerBytes);
  const display = headerHashDisplay(header);
  if (display !== cp.displayHash) {
    throw new Error(
      `checkpoint header hash mismatch: got ${display}, expected ${cp.displayHash}`,
    );
  }
  if (!meetsTarget(headerHashInternal(header), header.bits)) {
    throw new Error("checkpoint header fails PoW check");
  }
  const hashInternal = headerHashInternal(header);
  return {
    height: cp.height,
    hashDisplay: cp.displayHash,
    hashInternalHex: bytesToHex(hashInternal),
    headerHex: cp.headerHex,
    header,
    hashInternal,
  };
}
```

Do **not** leave the `PASTE` comment in the final file — the `CHECKPOINTS` binding must be real.

- [ ] **Step 3: Run checkpoint tests**

Run: `bun test tests/checkpoint.test.ts`

Expected: PASS

- [ ] **Step 4: Commit (only if user asked)**

```bash
git add src/checkpoint.ts tests/checkpoint.test.ts
git commit -m "$(cat <<'EOF'
Add year-keyed trusted checkpoints for 2009–2026.

EOF
)"
```

---

### Task 3: Update chain-headers fixture for new default tip

**Files:**
- Modify: `tests/chain-headers.test.ts`

**Interfaces:**
- Consumes: `CHECKPOINT_HEIGHT` (now `556416`), `BLUEBERRY_HEADER_CONSENSUS` via module default
- Produces: tests still pass against default year chain

- [ ] **Step 1: Replace the real next-header fixture**

In `tests/chain-headers.test.ts`, find the block that comments `Real mainnet header at 548353` and the `waitFor` expecting `548_353`.

Replace the next-header hex with height **556417** (child of default checkpoint 556416):

```ts
    // Real mainnet header at 556417 (links from default checkpoint 556416).
    const nextHeader = decodeBlockHeader(
      hexToBytes(
        "000000208fdfeffd2c3a3a235a847805dbd1dc5adb9cd48519532a000000000000000000105b6f8cba2f1258ea4c1e41f72e843c770c3acfede6f02df3108c6fba7b88bfca4f2a5ca5183217d6a930c9",
      ),
    );
```

Replace every assertion / wait that hardcodes `548_353` with `CHECKPOINT_HEIGHT + 1` (or `556_417`). Prefer `CHECKPOINT_HEIGHT + 1` so it stays tied to the default year.

Search the file for `548_352` / `548_353` and clear any remaining literals.

- [ ] **Step 2: Run affected tests**

Run:

```bash
bun test tests/checkpoint.test.ts tests/chain-headers.test.ts tests/trusted-chain.test.ts tests/sqlite-headers.test.ts
```

Expected: PASS

- [ ] **Step 3: Run full suite**

Run: `bun test`

Expected: PASS (or only pre-existing failures unrelated to checkpoints)

- [ ] **Step 4: Commit (only if user asked)**

```bash
git add tests/chain-headers.test.ts src/checkpoint.ts tests/checkpoint.test.ts docs/superpowers/specs/2026-08-05-blueberry-year-checkpoints-design.md docs/superpowers/plans/assets/2026-08-05-year-checkpoints.json docs/superpowers/plans/2026-08-05-blueberry-year-checkpoints.md
git commit -m "$(cat <<'EOF'
Retarget chain-headers fixtures to year-2019 default checkpoint.

EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| Map 2009–2026 in `checkpoint.ts` | 2 |
| `name` = year string | 1–2 |
| Retarget-at-or-before Jan 1 rule (baked) | 2 + asset |
| Genesis prev timestamps = ten zeros | asset / 2 |
| Helpers `checkpointForYear`, `consensusForYear`, seed/db with optional year | 2 |
| Default year 2019 @ 556416; legacy aliases | 2–3 |
| Tests: coverage, PoW, seed validate genesis/mid/default | 1–2 |
| No UI / no runtime fetch | all tasks |
| chain-headers still works with new default | 3 |
