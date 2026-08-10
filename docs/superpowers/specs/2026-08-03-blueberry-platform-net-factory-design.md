# blueberry platform net factory design

Date: 2026-08-03  
Status: approved (conversation)

## Goal

Make TCP connect and DNS resolution a platform dependency owned by the app entry (composition root), not hardcoded inside modules or `src/net` defaults. Modules stay reusable on React Native by swapping a small factory (e.g. `react-native-tcp-socket` + RN DNS).

## Decisions

| Topic | Choice |
|-------|--------|
| Injection site | Platform factory object passed into **network modules only** (Approach C) |
| `ModuleContext` | Remains `{ bus, db }` — no `net` on context |
| Factory surface | `connect` + `dns` (`PlatformNet`) |
| Node/Bun entry | `createNodePlatformNet()` wraps `bip324/node` + `node:dns` |
| Net helpers | `connect` **required** — no default `connectNodeTcp` |
| Test seams | Keep `probe` / `resolveSeeds` / `openSession` / `fetchBatch`; still require `net` on module options |
| RN adapter | Out of scope for this pass (factory shape only) |

## Architecture

```
main (Bun)
 ├── MessageBus
 ├── SqliteDatabase
 ├── createNodePlatformNet()  → PlatformNet
 └── network modules(options.net)
      ├── peers-discovery   → net.dns, net.connect → probePeer
      ├── chain-headers     → net.connect → header session pool
      ├── filters-download  → net.connect → filter open/pool
      └── blocks-download   → net.connect → openBlockSession

non-net modules (parse, matching, sync-idle, tui): unchanged
```

## Interfaces

```ts
type TcpConnect = (
  host: string,
  port: number,
  signal?: AbortSignal,
) => Promise<ByteDuplex>;

type PlatformNet = {
  connect: TcpConnect;
  dns: DnsResolver; // resolve4 / resolve6
};
```

## Module wiring

Network modules take **required** `net: PlatformNet` in options. Production defaults call through `net`; injected fakes still override the path but `net` remains required for a uniform constructor.

## Success criteria

- No `bip324/node` or `node:dns` imports under `src/modules/`
- No default `connectNodeTcp` inside peer-probe / header-sync / filter-sync / block-sync
- Only `main` (and `src/net/node-platform.ts`) import Node TCP/DNS
- `bun test` and `bun run typecheck` pass
