# blueberry year-keyed trusted checkpoints

Date: 2026-08-05  
Status: approved (conversation)

## Goal

Replace the single hardcoded sync anchor with a year-keyed map of trusted mainnet checkpoints (Bitcoin inception through the current calendar year). Each entry is suitable for `bitcoin-headers` consensus seeding and later onboarding “sync from year” UI. This slice is **data + helpers only** — no year-picker UI, no persisted user choice.

## Decisions

| Topic | Choice |
|-------|--------|
| Storage shape | Associative map in `src/checkpoint.ts` keyed by year number |
| Display `name` | Same as key stringified (`2018` → `"2018"`) |
| Year range | `2009` … `2026` inclusive |
| Height pick rule | Highest difficulty-period start (`height % 2016 === 0`) with block time ≤ `Y-01-01T00:00:00Z` |
| 2009 / pre-genesis | Height `0` (genesis); `previousTimestamps` = ten `0`s (library still requires `medianTimeSpan - 1` entries) |
| Scope | Map + helpers to build consensus / DB seed / seed record from a year; no UI |
| Default for existing sync | `DEFAULT_CHECKPOINT_YEAR = 2019` (height `556416` by the year rule). This supersedes the older mid-2018-era `548352` anchor. |
| Data layout | Inline in `checkpoint.ts` (Approach 1) — no generator script in this pass |

## Checkpoint entry

```ts
type YearCheckpoint = {
  name: string; // "2018"
  height: number; // % 2016 === 0 (except documented genesis case: 0)
  headerHex: string; // 80-byte header, hex
  displayHash: string; // big-endian block hash hex
  previousTimestamps: readonly number[]; // exactly 10 uint32 times, ascending heights
};
```

Map:

```ts
export const CHECKPOINTS: Readonly<Record<number, YearCheckpoint>>;
// keys: 2009, 2010, …, 2026
```

## Selection rule (normative)

For calendar year `Y`:

1. Let `t = Date.UTC(Y, 0, 1) / 1000` (Unix seconds of Jan 1 00:00 UTC).
2. Among mainnet headers with `timestamp <= t` and `height % 2016 === 0`, choose the maximum `height`.
3. If no such header exists (only possible for `Y === 2009` before genesis), use genesis (`height === 0`).
4. Store that header’s 80-byte serialization, display hash, and the ten timestamps of heights `height - 10` … `height - 1` (or ten zeros when `height === 0`).

Note: the chosen block may fall in late December of `Y - 1`; the map key/name remains `Y` (“sync covering from the start of year Y”).

## Helpers & legacy exports

| Export | Behavior |
|--------|----------|
| `DEFAULT_CHECKPOINT_YEAR` | `2019` (height `556416` by the year rule) |
| `checkpointForYear(year)` | Return `YearCheckpoint`; throw on unknown year |
| `consensusForYear(year)` | `HeaderConsensusParams` with mainnet constants + that checkpoint |
| `checkpointDbRecord(year?)` | DB row; default year = `DEFAULT_CHECKPOINT_YEAR` |
| `checkpointSeedRecord(year?)` | Lib seed + PoW/hash checks; default year as above |
| `BLUEBERRY_HEADER_CONSENSUS` | `consensusForYear(DEFAULT_CHECKPOINT_YEAR)` |
| `CHECKPOINT_HEIGHT` / `HEADER` / … | Re-export fields of the default year entry (compat for existing tests/modules) |

`chain-headers` keeps importing `BLUEBERRY_HEADER_CONSENSUS` unchanged in this pass.

## Validation (tests)

- Every key in `2009…2026` present; `name === String(year)`.
- Every `height % 2016 === 0` (including genesis `0`).
- Header decodes; display hash matches; PoW meets `bits`.
- `previousTimestamps.length === 10`.
- Default year is `2019` with height `556416` (year-rule result; not the retired `548352` fixture).
- `checkpointSeedRecord(year)` + `validateHeaderChain` succeeds for at least genesis (`2009`), default year (`2019`), and one mid-range year (e.g. `2015`).

## Out of scope

- Onboarding / TUI year picker
- Persisting chosen year in `key_value` / config
- Switching an existing DB to a different checkpoint (would require wipe or migration)
- Auto-refresh script for future years (`2027+`)

## Implementation note

Populate entries from a trusted mainnet source (local node or well-known explorer API) using the selection rule above; bake hex/timestamps into `src/checkpoint.ts`. Do not fetch at runtime.
