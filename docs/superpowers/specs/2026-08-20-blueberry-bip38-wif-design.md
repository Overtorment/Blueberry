# blueberry password-protected WIF (BIP38) and uncompressed WIF

Date: 2026-08-20  
Status: draft (awaiting review)

This spec supersedes two “out of scope” lines in `2026-08-08-blueberry-wif-import-design.md`: BIP38 encrypted keys, and uncompressed WIF.

## Goal

Let onboarding import a BIP38 password-protected WIF (`6P…`). If the app detects that form, it asks for the password, decrypts, and then follows the existing WIF path.

Also accept a raw uncompressed mainnet WIF (`5…`) as a single uncompressed legacy `p2pkh` watch.

## Decisions

| Topic | Choice |
|-------|--------|
| Detect | Trimmed secret is 58 characters and starts with `6P` (BIP38, both spec methods) |
| Password UI | New onboarding step; hide characters; Esc returns to Import |
| Decrypt | npm `bip38` (`decryptAsync`); official scrypt unless a test passes weaker params |
| Both BIP38 methods | Yes: prefix `0x0142` (`6PR`/`6PY`) and EC-multiply `0x0143` (`6Pf`/`6Pn`) |
| After decrypt | Encode mainnet WIF (`5…` or `K`/`L`) with `@scure/btc-signer` `WIF()` |
| Storage | KV `wallet_secret` stores the plain WIF only. Never store `6P…` or the password |
| Boot | No password prompt after a successful import |
| Compressed WIF (`K`/`L`) | Unchanged: four scripts; default receive native segwit |
| Uncompressed WIF (`5…`) | One script: uncompressed legacy `p2pkh`; receive and change are that address |
| Raw `5…` paste | Same one-script rule as an uncompressed key from BIP38 |
| Secret kind | Still `"wif"` (no new kind) |
| Library | npm `bip38` (bitcoinjs 3.1.1). Do not use the BlueWallet React Native fork |
| Tests | Port BlueWallet `tests/unit/bip38.test.ts`; add parse/derive/onboarding cases |

## Import flow

1. User pastes a secret on Import (current field).
2. If `isBip38Key(trimmed)`:
   - Do not call `saveWalletSecret` on the `6P…` string.
   - Open the password step. Keep the encrypted string in memory only.
3. User enters a password and presses Enter.
   - Empty password → stay on the step; show a short error.
   - Decrypt (async). Show a busy state. Official scrypt can take several seconds.
4. Success → encode WIF → existing parse/save (`onSecretValidated` with the plain WIF) → year step.
5. Wrong password → stay on the password step; show “incorrect password”; do not save.
6. Invalid `6P…` payload → show “invalid password-protected WIF”; do not save.
7. Esc on the password step → back to Import; clear the password; keep the `6P…` text in the import field.
8. Seed, zpub, raw WIF, or address → current one-step import. No password step.

A later boot reads the stored WIF. It does not ask for the BIP38 password again.

## Detect and decrypt

New helper `src/wallet/bip38.ts`:

```ts
export function isBip38Key(value: string): boolean;

export async function decryptBip38ToWif(
  encrypted: string,
  password: string,
  scryptParams?: { N: number; r: number; p: number },
): Promise<string>;
```

`isBip38Key`: trim; no whitespace inside; starts with `6P`; length 58 (BIP38 record length).

`decryptBip38ToWif`:

- Call `bip38.decryptAsync(encrypted, password, undefined, scryptParams)`.
- Default scrypt is the library/spec default (`N=16384`, `r=8`, `p=8`).
- Tests may pass `{ N: 1, r: 8, p: 8 }` (BlueWallet fast vector).
- On success, encode version `0x80` WIF with the library’s `compressed` flag.
- Map a wrong-password throw to a clear `Error` message that includes `incorrect password`.
- Do not implement encrypt.

`OnboardingApp` calls `isBip38Key` before `parseWalletSecret`. `parseWalletSecret` stays sync.

## Secret validation

`parseWalletSecret` after trim, insert BIP38 and allow `5…`:

1. `zpub…` → existing account zpub rules  
2. Other extended-key prefixes → reject (unchanged)  
3. `isBip38Key(value)` → throw `password-protected WIF requires a password` (no KV write)  
4. WIF-shaped candidate (`5` / `K` / `L`, length 51–52, no whitespace) → decode mainnet WIF → `{ kind: "wif", value }`  
   - Accept uncompressed `5…`  
   - Accept compressed `K`/`L`  
   - Reject testnet (`c…` / `9…`) with the current mainnet-only error  
5. Address → existing rules  
6. Else → BIP39 English mnemonic  

`inspectWalletSecret`: a leftover `6P…` in KV is `invalid` (parse throws). Boot exits. Do not open onboarding to “fix” it.

Add `decodeWif`. Keep `decodeWifPrivateKey` as a wrapper that returns only `privateKey` (it must accept `5…`). Derive and send call `decodeWif` and use `secp256k1.getPublicKey(privateKey, compressed)` so uncompressed `p2pkh` uses the 65-byte pubkey.

```ts
export function decodeWif(wif: string): {
  privateKey: Uint8Array;
  compressed: boolean;
};
```

## Derive / receive / send

`WatchWallet.kind` stays `"wif"`. Gap growth still no-ops.

**Compressed** (`compressed === true`): four scripts in the current order (legacy → wrapped → native → taproot). `preferredWifReceiveAddress` unchanged: no history → native segwit.

**Uncompressed** (`compressed === false`): one `WatchAddress`, `scriptType: "p2pkh"`, uncompressed `p2pkh` script. Do not add wrapped, native, or taproot.

`preferredWifReceiveAddress` must not require a native address. If the wallet has no `p2wpkh` (uncompressed case), return the sole `p2pkh` when there is no history. With history, keep first-touch among the watched scripts (one script).

Send: one private key. Uncompressed wallets only produce `p2pkh` inputs. Those inputs still need `nonWitnessUtxo`. `accountKey` for `"wif"` must pass the uncompressed pubkey into `p2pkh` when `compressed === false`.

## Onboarding TUI

- Import copy may mention a password-protected WIF.
- Password step: title such as “Password”; prompt such as “This WIF is password-protected. Enter the password.”
- Password field hides characters.
- Footer: Enter to continue, Esc to go back; while decrypting, show a busy line (e.g. “Decrypting…”).

## Files

- Create: `src/wallet/bip38.ts`
- Modify: `src/wallet/secret.ts`, `src/wallet/derive.ts`, `src/wallet/receive-address.ts`, `src/wallet/build-send-tx.ts`, `src/tui/OnboardingApp.tsx`
- Test: `tests/unit/bip38.test.ts` (BlueWallet port + app cases); update `tests/unit/wif-wallet.test.ts` (accept `5…`; keep compressed four-script cases)
- Dependency: `bip38` from npm (not `github:BlueWallet/bip38`)

## Tests

Port BlueWallet `tests/unit/bip38.test.ts`:

1. **Fast decrypt** (weak scrypt `{ N: 1, r: 8, p: 8 }`):
   - Encrypted: `6PRVWUbkzq2VVjRuv58jpwVjTeN46MeNmzUHqUjQptBJUHGcBakduhrUNc`
   - Password: `TestingOneTwoThree`
   - WIF: `5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR`
2. **Slow decrypt** (official scrypt): same as BlueWallet — present in the file, skipped on a normal run (`it.skip` / equivalent). Encrypted `6PnU5voARjBBykwSddwCdcn6Eu9EcsK24Gs5zWxbJbPZYW7eiYQP8XgKbN`, password `qwerty`, WIF `KxqRtpd9vFju297ACPKHrGkgXuberTveZPXbRDiQ3MXZycSQYtjc`. Wrong password `a` → incorrect password.

App tests:

- `parseWalletSecret("6P…")` throws (requires a password).
- `decryptBip38ToWif` + `parseWalletSecret` + `deriveWatchWallet` on the fast vector → `kind: "wif"`, exactly one `p2pkh`, address `1Jq6MksXQVWzrznvZzxkV6oY57oWXD9TXB` (uncompressed pubkey of that WIF).
- Raw `5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR` derives the same single script.
- A compressed WIF still unwraps four scripts.
- Wrong password on the fast vector fails with a clear error.
- `isBip38Key` is true for the 58-character `6P…` vectors and false for `K`/`L`/`5` WIF, zpub, mnemonic, and address.

## Out of scope

- Creating or encrypting BIP38 keys
- Testnet BIP38 or testnet WIF
- Storing `6P…` or the password
- BIP39 passphrase, AEZEED, SLIP39 (BlueWallet import extras)
- Changing HD / zpub / address-watch flows
- Uncompressed keys as four-script wallets
