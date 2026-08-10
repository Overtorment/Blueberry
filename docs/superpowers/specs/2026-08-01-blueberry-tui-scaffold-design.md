# blueberry TUI scaffold design

Date: 2026-08-01  
Status: approved (conversation)

## Goal

Scaffold an empty Bun project that launches an OpenTUI React dashboard via `bun start`. The dashboard shows seven bordered tile windows. Bodies are empty; sync/wallet logic comes later.

## Dependencies

```json
{
  "dependencies": {
    "bip324": "file:../bip324",
    "bip157": "file:../bip157",
    "bip158": "file:../bip158",
    "bitcoin-headers": "file:../bitcoin-headers",
    "@scure/bip32": "^1.7.0",
    "@scure/bip39": "^1.6.0",
    "@scure/btc-signer": "^1.8.1",
    "bitcoinjs-lib": "7.0.1",
    "@opentui/core": "^0.4.5",
    "@opentui/react": "^0.4.5",
    "react": "^19.2.0"
  }
}
```

Local `file:` packages are installed for later use but unused in this scaffold. Dev tooling: TypeScript, `@types/bun`, `@types/react` as needed for typecheck.

## Layout

Full-terminal column flex:

1. **Row 1** (short, equal tiles): Balance · Chain tip sync · Peers  
2. **Row 2** (short, equal tiles): Filters download · Filters matching · Blocks download  
3. **Row 3** (tall, `flexGrow`): Transactions  

Only Transactions grows to fill remaining height. Every window has a border and title. No top bar, no footer.

## Project structure

```
package.json          # listed deps; "start": "bun src/main.tsx"
tsconfig.json         # ESM, jsxImportSource @opentui/react
src/
  main.tsx            # createCliRenderer + createRoot → <App />
  App.tsx             # 3-row tile composition
  components/
    Balance.tsx
    ChainTipSync.tsx
    Peers.tsx
    FiltersDownload.tsx
    FiltersMatching.tsx
    BlocksDownload.tsx
    Transactions.tsx
```

## Components

Each window is a dedicated React component: a bordered titled box with an empty body. `App` only arranges them; it does not hold domain state.

## Runtime behavior

- `bun start` creates the CLI renderer, mounts `App`, and runs until quit.
- Quit via Ctrl+C (renderer default).
- No wallet, P2P, or sync engine in this scaffold.
- Minimal styling: simple borders/titles; no accent theme yet.
- No tests in this scaffold; TypeScript configured so the UI shell typechecks.

## Out of scope

- Sync engine, peer management, filter/block download, wallet balance/tx list
- Persistence, config, networking
- Tests and CI
- Visual theming beyond bordered titled tiles
