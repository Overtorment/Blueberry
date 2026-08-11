# Order-Independent Spend Detection

## Goal

Never miss wallet spends because a spend block was parsed before its receive.
Balance must stay correct across parse-order races and heal already-corrupted DBs.

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

## Repair

On `parse-blocks` start and whenever sync becomes idle, scan current UTXOs for
outpoint spends inside downloaded blocks that are not yet recorded as wallet
transactions. Clear those heights from `parsed_blocks` so normal parsing
re-extracts them.

## Scope

- `src/parse/extract.ts`, `src/parse/used-indexes.ts`
- DB helpers for outpoint search / clearing a single parsed height
- `src/modules/parse-blocks.ts` repair kick
- Unit tests for P2PKH/P2SH-P2WPKH order-independent spends and orphan requeue

Do not change filter matching, download concurrency, or idle gating semantics.
