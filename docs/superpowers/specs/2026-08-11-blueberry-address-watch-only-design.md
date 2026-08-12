# blueberry single-address watch-only import

Date: 2026-08-11  
Status: approved (conversation)

## Goal

Let the user import a **mainnet Bitcoin address** as a watch-only wallet: track only that script (balance, history, receive). Join the fixed watch-set idea from WIF with the watch-only send path from account `zpub`.

## Decisions

| Topic | Choice |
|-------|--------|
| Input | Mainnet address only (`1…` / `3…` / `bc1q…` / `bc1p…`) via existing `isAddressValid` |
| Secret kind | Add `"address"` alongside `"mnemonic"` \| `"zpub"` \| `"wif"` |
| Storage | Trimmed address string in `wallet_secret` (same KV key) |
| Watch set | Exactly one script — no HD gap growth |
| Receive | Always that address |
| Change | Always the same watched address (non-max); max uses payee as today |
| Send | Unsigned PSBT (same branch as `zpub`); never signs |
| PSBT metadata | UTXO data always; taproot can use x-only key from address; hash-based types are script-only (no bip32Derivation / no reconstructed pubkey) |
| UI | Same onboarding field; update copy to mention address |

## Secret validation

After trim, extend `parseWalletSecret`:

1. `zpub…` → existing account zpub rules  
2. Other extended-key prefixes → reject (unchanged)  
3. WIF-shaped candidate → existing mainnet compressed WIF rules  
4. `isAddressValid(value)` → `{ kind: "address", value }`  
5. Else → BIP39 English mnemonic  

Invalid address → clear error; no KV write.

Addresses have no whitespace (unlike mnemonics) and do not collide with compressed WIF length/prefix rules.

## Derive

- Decode address → `scriptPubKey` (source of truth for matching) + `scriptType` label:
  - `1…` → `p2pkh`
  - `3…` → `p2sh-p2wpkh` (only P2SH bucket in the existing type enum; redeem script unknown)
  - `bc1q…` (v0, 20-byte) → `p2wpkh`
  - `bc1p…` (v1, 32-byte) → `p2tr`
- `WatchWallet.kind = "address"`.  
- Single `WatchAddress` (e.g. path `address/0`, `change: false`).  
- Gaps argument ignored.  
- Filter matching stays `wallet.scripts()` (one entry).

## Receive / change / gaps

- Receive store: always the sole watched address when `kind === "address"`.  
- `buildActiveSendTx`: change address = that same address when `kind === "address"` (and not send-max).  
- `maybeGrowWatch` no-ops for `kind === "address"` (same as WIF).

## Send / PSBT

- `buildSend`: mnemonic/wif → signed; **zpub or address → unsigned PSBT**.  
- Inputs: `witnessUtxo` (and `nonWitnessUtxo` for legacy when prev tx is in DB).  
- Taproot: build `p2tr` from the address’s embedded x-only key.  
- Other types: script/UTXO only — no BIP32 derivation metadata. Nested `3…` remains script-hash only (no redeemScript in this slice).

## Onboarding TUI

Update import prompt/placeholder to include address (e.g. seed, zpub, WIF, or address). Auto-detect only; no new step or mode.

## Error handling

| Case | Behavior |
|------|----------|
| Bad address on onboarding | Inline TUI error; no write; no re-exec |
| Testnet / invalid mainnet form | Rejected by `isAddressValid` / parse |
| Module start without secret | Unchanged hard failure |

## Tests

- Parse: good legacy / nested / native / taproot → `kind: "address"`; reject junk; WIF and mnemonic still classified correctly.  
- Derive: one script; matches `toOutputScript` / expected type; gaps ignored.  
- Receive + change helpers for address wallets.  
- `buildSend` → PSBT; change to same address; send-max unchanged.  
- Gap growth no-op for `kind === "address"`.

## Out of scope

- Multi-address watch lists  
- RedeemScript recovery for nested P2SH  
- Testnet / signet  
- Upgrading an address wallet to a hot wallet later  
- Encrypting `wallet_secret` at rest  
- BIP38 / uncompressed WIF (unchanged)

## Files (expected)

| Path | Role |
|------|------|
| `src/wallet/secret.ts` | Detect `"address"`; extend `WalletSecretKind` |
| `src/wallet/derive.ts` | Single-script derive path |
| `src/wallet/types.ts` | `WatchWalletKind` includes `"address"` |
| `src/wallet/build-send-tx.ts` | Address → unsigned PSBT; input construction |
| `src/tui/send-context.ts` | Change = watched address |
| `src/tui/receive-address-store.ts` | Receive = watched address |
| `src/modules/parse-blocks.ts` | Gap growth no-op |
| `src/tui/OnboardingApp.tsx` | Copy |
| `tests/unit/*` | Parse / derive / send / gaps |
