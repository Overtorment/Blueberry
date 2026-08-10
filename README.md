# Blueberry

A private Bitcoin wallet for your terminal.

Early software. Still under active development.

Blueberry is a light Bitcoin wallet that runs in the terminal. It uses Neutrino-style compact filters to sync without downloading the full chain, and it favors private network paths — encrypted BIP-324 peers, and Tor when you broadcast a spend. You can create or restore a wallet, see balance and history, receive, and send.

## Features

- **Neutrino light sync** — headers + compact filters; fetch full blocks only when they match your wallet
- **Private by default** — BIP-324 encrypted peer links; broadcast spends over Tor
- **Native SegWit (BIP84)** — HD receive and change on `bc1…` addresses
- **Create or restore** — new 12-word seed, or import a seed / account `zpub` / compressed `WIF`
- **WIF single-key** — one private key unwraps to legacy, wrapped segwit, native segwit, and taproot; receive follows the earliest used type; send spends mixed UTXOs
- **Watch-only ready** — `zpub` wallets can build unsigned PSBTs (including air-gapped / Keystone-style UR QR flow)
- **Receive** — unused address plus terminal QR
- **Send** — set amount or send max; hot wallets sign in-app; watch-only export for external signing
- **Live sync dashboard** — peers, chain tip, filters, matching, blocks, balance, and transactions in one TUI

Built for people who want Neutrino-style light sync and stronger privacy, without leaving the terminal.
