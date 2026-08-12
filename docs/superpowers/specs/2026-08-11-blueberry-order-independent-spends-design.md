# Order-Independent Spend Detection

## Goal

Never miss wallet spends because a spend block was parsed before its receive.

## Root cause

`extractWatchTxs` recognized non-SegWit spends only via a prior UTXO map.
Legacy P2PKH spends carry the pubkey in `scriptSig`, not witness. If the spend
block was marked parsed before the receive UTXO was known, the spend was lost
forever.

## Detection

Treat an input as wallet-relevant when any of these match a watched script:

- known prior outpoint in the UTXO map
- witness compressed pubkey → P2WPKH or P2SH-P2WPKH
- scriptSig compressed/uncompressed pubkey → P2PKH

Update `usedWatchIndexes` with the same pubkey→script matching.
Taproot key-path spends remain UTXO-map-only (key not recoverable from the spend alone).

## Scope

- `src/parse/extract.ts`, `src/parse/used-indexes.ts`
- Unit tests for P2PKH/P2SH-P2WPKH order-independent spends

Do not change filter matching, download concurrency, or idle gating semantics.
No runtime DB healing/requeue pass — detection alone is the shipped fix.
