# blueberry onboarding + wallet secret in key_value

Date: 2026-08-05  
Status: approved (conversation)

## Goal

Stop storing the BIP39 mnemonic in `config`. Persist a wallet secret (BIP39 mnemonic **or** account-level mainnet `zpub`) in the SQLite `key_value` table. If the secret is missing, do not start the sync app — show a dedicated onboarding TUI, then soft-re-exec into a normal cold start once saved.

## Decisions

| Topic | Choice |
|-------|--------|
| Storage | Single `key_value` key `wallet_secret` (raw string; auto-detect kind) |
| Config | Remove `config.seed` entirely |
| Boot when missing | Dedicated onboarding TUI only — no bus/modules/main dashboard |
| After save | Soft re-exec of the same entry (cold-start parity) |
| Mutability | Immutable in-app for this slice (no change/reset UI) |
| Networks | Mainnet only — accept `zpub`, reject `vpub` / other prefixes |
| Zpub semantics | Account-level BIP84; derive `{0\|1}/i` → `p2wpkh` (same as mnemonic BIP84) |
| Encryption | None (plaintext in DB, same trust model as former config seed) |

## Boot gate & soft re-exec

1. `main` ensures `./data`, opens SQLite, reads `key_value.get("wallet_secret")`.
2. **Missing/empty** → onboarding mode:
   - Create OpenTUI renderer and render `OnboardingApp` only.
   - Do **not** construct message bus, domain modules, progress stores, or main `App`.
   - Quit via `q` / Ctrl+C → hard exit (same spirit as today’s shutdown).
3. **Present** → existing path: bus, stores, modules, main `App`, `app:started`.
4. On successful onboarding submit: validate → `keyValue.set("wallet_secret", trimmed)` → tear down onboarding renderer → soft re-exec the same process entry (same cwd + argv) so the next run takes the “secret present” path.
5. Re-exec failure → stderr + non-zero exit; never fall through into a half-started sync app.

```
open DB
    │
    ├─ no wallet_secret ──► OnboardingApp ──► save ──► re-exec ──┐
    │                                                             │
    └─ has wallet_secret ◄────────────────────────────────────────┘
                │
                ▼
         bus + modules + main App
```

## Secret format, validation, BIP84 derive

### Detection (after trim)

- Starts with `zpub` → account-level BIP84 extended public key (mainnet).
- Otherwise → BIP39 mnemonic (English `validateMnemonic`).

### Reject

- Empty / whitespace-only
- Invalid mnemonic
- Extended keys that are not mainnet account `zpub` (`xpub`, `vpub`, wrong version, malformed, unsuitable depth for account use)

### Derive (`deriveWatchWallet(secret, gaps)`)

- **Mnemonic:** unchanged — master seed → `m/84'/0'/0'/{0|1}/i` → `p2wpkh`.
- **Zpub:** `HDKey.fromExtendedKey(zpub)` at account → derive `{0|1}/i` only → same `p2wpkh` scripts/addresses.
- Gaps / `watch_external` / `watch_internal` behavior unchanged.
- Prefer renaming the wallet field from `mnemonic` to `secret` (or equivalent) so zpub is not mislabeled; scripts/addresses API for match/parse stays the same.

Shared helpers (e.g. `src/wallet/secret.ts`): parse/validate and load from DB — used by onboarding and by derive/modules so there is one validation path.

## Onboarding TUI

Dedicated `OnboardingApp` (not the main dashboard):

- Full-terminal cyberpunk chrome (`THEME`); no sync strip / balance / transactions.
- One composition: centered **BLUEBERRY** wordmark (reuse `BlueberryArt`) plus one bordered input window below it.
- Prompt: enter BIP39 seed or account zpub; submit with Enter.
- Invalid input → one-line error under the field; no KV write; stay on onboarding.
- Valid input → persist, then soft re-exec.
- Echo input as typed (no masking required in this slice).
- No post-onboarding “change wallet” UI.

## Module wiring

- Remove `seed` from `src/config.ts`.
- `createParseBlocksModule` / `createFiltersMatchingModule` (and any other consumer):  
  `options.seed ?? db.keyValue.get("wallet_secret")`; throw / module error if absent at start.
- Keep the module option name `seed` as a test/override string (mnemonic or zpub) to avoid churn; runtime source of truth is `wallet_secret` in KV.
- Gate in `main` is the primary guard; modules treat missing secret as a hard failure.

## Error handling

| Case | Behavior |
|------|----------|
| Bad secret on onboarding | Inline TUI error; no write; no re-exec |
| DB write failure | Inline TUI error; no re-exec |
| Re-exec failure | Stderr + exit ≠ 0 |
| Module start without secret | Module error status (should not happen after gate) |

## Tests

- Parse/validate: good mnemonic; bad mnemonic; good zpub → watch scripts; reject `xpub` / `vpub`.
- Derive parity: zpub taken from a known mnemonic’s BIP84 account key yields the same external/internal `p2wpkh` scripts as deriving from that mnemonic.
- KV round-trip for `wallet_secret`; gate helper unit-tested if extracted from `main`.
- Existing module tests continue to pass `options.seed` explicitly.

## Out of scope

- Encrypting `wallet_secret` at rest
- Changing or resetting the wallet after first save
- Testnet / signet (`vpub`)
- Automatically migrating the former hardcoded `config.seed` into KV

## Files (expected)

| Path | Role |
|------|------|
| `src/config.ts` | Remove `seed` |
| `src/main.tsx` | Gate + onboarding vs app boot + soft re-exec |
| `src/tui/OnboardingApp.tsx` (or similar) | Dedicated onboarding UI |
| `src/wallet/secret.ts` (or similar) | Load / parse / validate |
| `src/wallet/derive.ts` | Mnemonic + zpub derive paths |
| `src/wallet/types.ts` | `secret` field naming |
| `src/modules/parse-blocks.ts` | Load secret from DB |
| `src/modules/filters-matching.ts` | Load secret from DB |
| `tests/*` | Secret validation + zpub derive parity + wiring |
