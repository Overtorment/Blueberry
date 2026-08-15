# blueberry debug file log design

Date: 2026-08-15  
Status: approved (conversation)

## Goal

Keep the existing append-only file log. Open it only when the process has `--log`. When the file is open, write enough scoped lines that a later reader can debug sync, wallet, and send issues from the file alone.

## Decisions

| Topic | Choice |
|-------|--------|
| Enable flag | Exact argv token `--log` (`process.argv.includes("--log")`) |
| Log path | Unchanged: `./blueberry.data/blueberry.log` |
| `--log <path>` | Out of scope — flag only |
| Write API | Keep `initFileLog` / `closeFileLog` / `getLogPath` / `log` / `logError` in `src/log.ts` |
| Logger injection | Do not add a Logger type or pass a logger into every module |
| Test seams | Keep optional `log?: (message: string) => void` on `blocks-download` and `filters-download` only |
| Levels / packages | Out of scope — no debug/info/warn, no tracing crate |
| Re-exec | `reexecSelf` already forwards `process.argv.slice(1)`, so `--log` survives onboarding restart |

## Gate

`main.tsx` always creates `./blueberry.data`. It calls `initFileLog` only when argv contains `--log`.

Without `--log`:

- Do not create or open the log file.
- `log` / `logError` stay no-ops (`logPath` remains `null`).
- Existing call sites (broadcast, detach-loop, download modules) stay safe.

With `--log`:

- Same banner and line format as today: `ISO [scope] message`.
- First app line after the banner is `[main] boot` (already present).

Parse argv with `shouldEnableFileLog(process.argv)` in `src/log.ts` (`true` only for an exact `--log` token). `main.tsx` calls that helper. Do not add a CLI parser.

## How modules log

Call `log("scope", message)` or `logError("scope", message, err)` from `src/log.ts`.

`scope` is the module or package name:

| Scope | Owner |
|-------|--------|
| `main` | boot, onboarding vs `startApp`, fatal errors, shutdown |
| `tui` | route changes, receive/send open/close, quit |
| `wallet` | watch-gap load/growth, birthday freeze/pending (never secret bytes) |
| `peers-discovery` | DNS reseed, probe success/fail, pause/resume |
| `chain-headers` | start/stop, locator/tip progress, rewind, errors |
| `filters-download` | existing diagnostics |
| `filters-matching` | start/stop, batch match counts, watch refresh |
| `blocks-download` | existing diagnostics |
| `parse-blocks` | start/stop, batch sizes, parse errors, gap growth kick |
| `sync-idle` | idle ↔ catchup transitions and reason |
| `broadcast` | existing dial/attempt/success/error lines |
| `net` | connect/timeout/handshake failures that a module does not already log |

A helper under `src/net` or `src/wallet` may call `log` with the scope above. Do not thread a logger argument through those helpers.

## What to log

Log state changes and failures, not loops or bytes.

**Do log**

- Boot path: onboarding vs `startApp`, sync year, module start failures
- Module start / stop / background-loop errors (`detachLoop` already logs)
- `sync:idle` / `sync:catchup` with the reason already computed
- Batch or run boundaries: header batch accepted, filter run start, match batch (scanned/matched), parse batch (heights), block download start/fail
- Peer/DNS outcomes that change the pool (reseed, probe fail with host, pause/resume)
- Watch-gap growth (`external` / `internal` counts only)
- Send/broadcast path (already present)
- Unhandled rejection and fatal boot (already present)

**Do not log**

- Mnemonic, WIF, `wallet_secret`, raw PSBT, or full transaction hex
- Per-packet P2P, per-header, per-filter, or per-block payload
- Per-React-render or per-keypress (except quit)
- Secrets in error strings; keep using `formatError` for thrown errors

Dedup noisy repeats the same way download modules already do (log a queue/progress line when the text changes, not every poll).

## Files (approx.)

| Path | Role |
|------|------|
| `src/main.tsx` | `if (shouldEnableFileLog(process.argv)) initFileLog(...)`; log boot path |
| `src/log.ts` | Unchanged write API; add `shouldEnableFileLog(argv)` |
| `src/modules/*.ts` | Add `log` / `logError` at the events above |
| `src/wallet/*.ts` | Gap/birthday lines only; no secret material |
| `src/tui/*` | Route / send-receive / quit lines |
| `tests/unit/log.test.ts` | Flag-off is silent; flag-on writes scoped lines |

Do not change `src/log.ts` line format. Existing download and broadcast tests stay valid.

## Testing

- `initFileLog` unset: `log` / `logError` write nothing and do not create a file.
- `initFileLog` set: scoped lines append as today.
- `shouldEnableFileLog` is true only for an exact `--log` token (`--log=1` and `--logs` are false).
- Existing `blocks-download` / `filters-download` / `broadcast` log assertions stay green.

## Out of scope

- Log rotation, size cap, or stdout mirroring
- `--log <path>` or env-var enable
- Log levels, structured JSON, or a Logger interface
- Passing a logger into every `createXModule`
