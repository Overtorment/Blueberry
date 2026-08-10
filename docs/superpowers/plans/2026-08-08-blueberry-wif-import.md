# blueberry WIF import — implementation plan

Date: 2026-08-08  
Spec: `docs/superpowers/specs/2026-08-08-blueberry-wif-import-design.md`

## Done

1. `parseWalletSecret` — detect/validate mainnet compressed WIF (`decodeWifPrivateKey`)
2. `deriveWatchWallet` — WIF → 4 scripts; `WatchWallet.kind = "wif"`
3. `preferredWifReceiveAddress` — earliest touch (watched output or spend of known outpoint); default `p2wpkh`
4. Receive store + send-context change path for WIF
5. `build-send-tx` — per-script-type payments; mixed UTXO signing; `nonWitnessUtxo` for p2pkh
6. Gap growth skipped for WIF
7. Onboarding copy updated
8. Tests: BlueWallet address vectors + signing (legacy/p2sh/p2wpkh/taproot) + mixed-type tx
