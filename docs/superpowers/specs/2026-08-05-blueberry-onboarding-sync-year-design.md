# blueberry onboarding sync-from-year picker

Date: 2026-08-05  
Status: approved (conversation)

## Goal

After wallet secret import/validation in onboarding, ask which calendar year to sync headers from. Persist the choice, then wire `chain-headers` to that year’s trusted checkpoint. Completes the year-checkpoint data work for first-run UX.

## Decisions

| Topic | Choice |
|-------|--------|
| Prompt copy | `What year was the first transaction for this wallet?` |
| Year list | All keys in `CHECKPOINTS` (2009–2026), ascending by year |
| Initial highlight | `DEFAULT_CHECKPOINT_YEAR` (2019) |
| Navigation | OpenTUI `<select>` — ↑/↓ move, Enter confirm |
| Storage | `key_value` key `sync_from_year` = decimal year string (e.g. `"2019"`) |
| Persist timing | Save `wallet_secret` on step 1; save `sync_from_year` on step 2 confirm; then soft re-exec |
| Incomplete onboarding | Secret present + year missing/invalid → year-picker only (no re-entry of seed) |
| Sync wiring | `createChainHeadersModule(ctx, { net, consensus: consensusForYear(year) })` |
| Mutability | No in-app change of year after onboarding (same as wallet secret) |
| UI shell | Stay in dedicated onboarding TUI (BLUEBERRY + one panel); not the main dashboard |

## Boot gate

Extend the cold-start gate beyond `wallet_secret` alone:

1. Open DB.
2. Inspect `wallet_secret` (unchanged: missing / ok / invalid).
3. Inspect `sync_from_year`:
   - missing/empty, or not a known `CHECKPOINTS` year → **year incomplete**
   - valid year string in `CHECKPOINTS` → **year ok**
4. Routing:

| `wallet_secret` | `sync_from_year` | Action |
|-----------------|------------------|--------|
| invalid | * | stderr + exit (unchanged) |
| missing | * | Onboarding step 1 (secret), then step 2 (year) |
| ok | incomplete | Onboarding step 2 only |
| ok | ok | `startApp` with that year’s consensus |

Invalid year values in KV are treated as incomplete (show picker), not a hard exit — operator can fix by choosing again. Do not delete a valid `wallet_secret` in that case.

## Onboarding UI

### Step 1 — Wallet (existing)

Unchanged: BIP39 / zpub input, validate, on success persist `wallet_secret` and advance to step 2 (do **not** re-exec yet).

### Step 2 — Sync year (new)

- Same chrome: centered BLUEBERRY + one `Panel`.
- Title e.g. `Sync from`.
- Body: prompt text above; `<select>` listing each year name (`"2009"` … `"2026"`); hint `↑/↓ to choose · Enter to confirm`.
- `selectedIndex` initial = index of `DEFAULT_CHECKPOINT_YEAR`.
- `showDescription={false}` (names are enough).
- On Enter/`onSelect`: validate year ∈ `CHECKPOINTS` → `keyValue.set("sync_from_year", String(year))` → tear down renderer → soft re-exec (same as today’s secret-only path).

Ctrl+C / SIGINT during either step: hard exit without writing the year (secret may already be saved — next boot resumes at step 2).

## Helpers

Small KV helpers (e.g. in `src/checkpoint.ts` or a tiny `src/sync-year.ts`):

- `SYNC_FROM_YEAR_KEY = "sync_from_year"`
- `listCheckpointYears(): number[]` — sorted keys of `CHECKPOINTS`
- `parseSyncFromYear(raw: string | null): number | null` — trim, parse int, must be in `CHECKPOINTS`
- `loadSyncFromYear(db) / saveSyncFromYear(db, year)` — load throws if missing/invalid; save validates then sets
- `inspectSyncFromYear(db): { status: "missing" } | { status: "ok"; year: number }` — for boot (invalid → missing)

## `startApp` wiring

```ts
const year = loadSyncFromYear(db); // or from inspect ok branch
createChainHeadersModule(ctx, {
  net,
  consensus: consensusForYear(year),
});
```

Default `BLUEBERRY_HEADER_CONSENSUS` remains the 2019 alias for tests / callers that omit `consensus`.

## Testing

- Onboarding step machine: secret submit advances to year step without re-exec; year confirm calls save + finish callback with chosen year.
- Keyboard: ↑/↓ changes selection; Enter confirms current year (unit-test selection state / callbacks; avoid brittle full TUI).
- Boot helpers: missing year → incomplete; `"2019"` → ok; `"1999"` / garbage → incomplete.
- `main` / integration-style: with secret+year in KV, `createChainHeadersModule` receives `consensusForYear(year)` (inject/spy or assert via module options in a thin test of the wiring helper if extracted).

## Out of scope

- Changing sync year after first run
- Migrating / wiping an existing headers DB when year changes
- Showing checkpoint height in the picker UI
- Auto-detecting first wallet tx year from chain data
