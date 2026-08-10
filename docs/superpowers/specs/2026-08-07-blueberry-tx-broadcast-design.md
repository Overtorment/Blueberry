# blueberry tx broadcast design

Date: 2026-08-07  
Status: implemented

## Goal

Broadcast a signed transaction to **clearnet** alive peers over Tor (echalote exit) using Bitcoin P2P **BIP-324 (v2)**.

## Decisions

| Topic | Choice |
|-------|--------|
| Tor dial | `createExitDialer` from echalote → blueberry `ByteDuplex` adapter |
| Peer source | Alive `NODE_NETWORK` peers (`listAliveWithServices`, capped) |
| Onion | Not stored / not used (echalote has no HS client) |
| Empty pool | Wait until alive peers appear (Esc cancels) |
| Delivery | Up to 20 attempts until one succeeds; each picks a random alive peer (reuse allowed). No fan-out. |
| App protocol | BIP-324 + version/verack + `tx` |
| Ack | `inv`/`getdata` for txid, or timeout/close without `reject` |
| UI | Signed-tx preview: focused Broadcast (Enter); progress view; Esc cancels only |

## Architecture

- `src/modules/broadcast/` — module + Tor→ByteDuplex adapter + BIP-324 `tx` send
- TUI store + Send preview button / progress body
