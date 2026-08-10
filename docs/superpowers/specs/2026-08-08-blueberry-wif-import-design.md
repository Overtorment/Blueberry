# blueberry WIF import (single-key, four address types)

Date: 2026-08-08  
Status: approved (cloud agent; requirements from product owner)

## Goal

Allow onboarding import of a mainnet compressed **WIF** private key. One key unwraps to four watch scripts (legacy, wrapped segwit, native segwit, taproot). Receive prefers the address type with the earliest on-chain activity. Send can spend UTXOs of any mix of those types.

## Decisions

| Topic | Choice |
|-------|--------|
| Secret kind | Add `"wif"` alongside `"mnemonic"` \| `"zpub"` |
| Networks | Mainnet compressed WIF only (`K`/`L`); reject uncompressed (`5…`) and testnet |
| Watch set | Always exactly 4 scripts — no HD gap growth |
| Default receive (no history) | Native segwit (`p2wpkh`) |
| Receive with history | Address type of the chronologically earliest touching tx |
| Change | Same as preferred receive address |
| Signing | Hot: sign in-app with the WIF; mixed script types in one tx supported |
| Legacy inputs | Attach `nonWitnessUtxo` from stored prev tx when building sends |
| Tests | Port BlueWallet single-key address / tx vectors; add mixed-type signing cases |

## Secret validation

After trim:

1. `zpub…` → existing account zpub rules  
2. Other extended-key prefixes → reject (unchanged)  
3. Single-token base58 that decodes as mainnet compressed WIF → `{ kind: "wif", value }`  
4. Else → BIP39 English mnemonic  

Invalid WIF → clear error; no KV write.

## Derive

From WIF → secp256k1 compressed pubkey → four payments:

1. `p2pkh` (legacy)  
2. `p2sh(p2wpkh)` (wrapped segwit)  
3. `p2wpkh` (native segwit)  
4. `p2tr(x-only)` (taproot key-path)

`WatchWallet.kind = "wif"`. Gaps ignored. Filter matching stays `wallet.scripts()` (four entries).

## Receive / change

`preferredWifReceiveAddress(wallet, txs)`:

- Build watched outpoints from all txs (outputs that hit watched scripts)  
- Sort txs by `(height, txIndex)`  
- First touch wins: watched output, or input that spends a known watched outpoint  
- Within one tx: outputs before inputs  
- If none → native segwit  

HD wallets set `WatchWallet.kind = "bip84"`. Receive/change paths unchanged when `kind !== "wif"`.

## Send / sign

- UTXO list already unions all watched scripts — no UI filter change required beyond correct scripts.  
- Builder maps each input script → payment (`p2pkh` / `p2sh-p2wpkh` / `p2wpkh` / `p2tr`) and signs with the single private key.  
- `p2pkh` requires `nonWitnessUtxo`; send-context attaches the prev tx bytes from `transactions` when present.  
- `buildSend`: mnemonic or wif → signed; zpub → PSBT.

## Gap growth

`maybeGrowWatch` no-ops for `kind === "wif"`.

## Out of scope

BIP38 encrypted keys, uncompressed WIF, testnet, HD `xprv`/`zprv`, message sign/verify UI.
