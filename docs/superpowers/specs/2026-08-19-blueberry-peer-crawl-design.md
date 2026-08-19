# blueberry peer crawl design

Date: 2026-08-19  
Status: approved (conversation)

## Goal

Restore a `getaddr` crawl on top of DNS peer discovery. Grow the SQLite peer book from live peers while discovery is running. A slow or empty `getaddr` must not mark a good handshake as dead. Do not delete peer rows.

This revises the 2026-08-01 peer-discovery spec (crawl via `getaddr`) and keeps the 2026-08-03 sync-idle pause.

## Decisions

| Topic | Choice |
|-------|--------|
| When crawl runs | Only while `peers-discovery` is not paused (catchup / behind) |
| Idle | No probes, no DNS reseed, no `getaddr` after `sync:idle` if any alive peer remains |
| Ingest | Save the whole first useful `addr` / `addrv2` dump (onion / bad port skipped) |
| Cadence | One `getaddr` in flight; at most one attempt per 15s |
| Architecture | Two-phase `probePeer` (Approach 1) — same TCP session |
| Handshake budget | Existing `peerProbeTimeoutMs` (3s). Fail → source dead |
| Addr budget | New `peerAddrTimeoutMs` (3s) after handshake success only |
| Purge | Never delete / expire / cap peer rows |
| Schema | No new columns |
| TUI | Unchanged. Known count stays `db.peers.count()` |
| Piggyback on sync sockets | Out of scope |

## Architecture

```
peers-discovery loop
  ├── DNS bootstrap / reseed          (unchanged)
  ├── probe batch (concurrency 30)    (handshake, 3s)
  └── at most 1 probe with wantAddr   (getaddr, extra 3s)
        └── upsert candidates from addr / addrv2
```

`completeVersionHandshake` already sends `sendaddrv2` before `verack`. Keep that.

Parse addresses with existing `src/net/addr.ts` (`addrV2ToCandidate`, `legacyAddrToCandidate`).

## Probe (`src/net/peer-probe.ts`)

`probePeer` stays the only connect path. Add options:

- `wantAddr?: boolean` (default `false`)
- `addrTimeoutMs?: number` (default `config.peerAddrTimeoutMs`)

Sequence:

1. Connect + BIP-324 + version/verack within `timeoutMs` (`peerProbeTimeoutMs`). Fail → `{ ok: false, error }`.
2. Success → services from the peer `version`. This result is already a live peer.
3. If `wantAddr` is false: return `{ ok: true, peers: [], services }` and close.
4. If `wantAddr` is true: send `getaddr`. Start a **new** 3s timer (`addrTimeoutMs`). The handshake timer does not cover this phase.
5. Read messages until the addr timer fires, or until one `addr` / `addrv2` payload has **2 or more** addresses (normal dump). Reply to `ping`. Collect every IPv4/IPv6 from all `addr` / `addrv2` seen in this phase (peers often send a 1-address self-announce first).
6. Addr timeout or empty list: still return `{ ok: true, peers, services }` with whatever was collected (may be `[]`).
7. Close the socket.

A silent peer after `verack` must keep succeeding with `peers: []` when `wantAddr` is false **or** when `wantAddr` is true and no dump arrives.

## Discovery loop (`src/modules/peers-discovery.ts`)

DNS, probe queue, CF preference, pause/resume stay as they are.

On each spawn, set `wantAddr` on **one** probe if all of:

- `paused` is false
- no crawl is in flight
- `now - lastCrawlAt >= peerCrawlIntervalMs` (15_000)

After that probe settles (ok or fail), clear the crawl-in-flight flag and set `lastCrawlAt = now`. A failed handshake still consumes the 15s slot (no retry storm).

On `result.ok`:

- upsert source with `alive: true` and handshake `services`
- `markProbed` + `markAlive(true)` as today
- for each `result.peers` entry: `upsertCandidate` (`alive: false`, `lastProbedAt: null`; keep payload `services` if non-zero)
- existing `ON CONFLICT` rules stay (do not wipe `alive` / `last_probed_at`)

On fail: `markProbed` + `markAlive(false)` as today.

Log when a crawl probe returns (including empty):  
`[peers-discovery] crawl source=host:port addrs=N`

Do not log a separate error for addr timeout.

## Config

Add to `src/config.ts`:

| Field | Default | Meaning |
|-------|---------|---------|
| `peerAddrTimeoutMs` | 3_000 | Wait for `addr` / `addrv2` after a good handshake |
| `peerCrawlIntervalMs` | 15_000 | Minimum time between crawl attempts |

Inject the same values on `PeersDiscoveryOptions` for tests.

## Errors

- Connect / handshake / probe timeout: source dead. Same as today.
- `getaddr` timeout or empty: source stays alive.
- Onion / unknown network id / port 0: skip that address.
- In-flight probes may finish after `sync:idle`. Do not spawn new ones. Do not start DNS or crawl.

## Testing

- Keep: succeeds after verack without waiting for `getaddr` (`wantAddr` false / silent peer).
- `wantAddr` true + `addrv2` after handshake → `ok`, candidates parsed (IPv4/IPv6 only).
- `wantAddr` true + handshake ok + no addr before `addrTimeoutMs` → `ok`, `peers: []`.
- Module upserts crawl candidates; only one crawl in flight; 15s gate.
- After `sync:idle` with an alive peer: no `wantAddr` / no `getaddr`.

## Out of scope

- Delete, expire, or cap peer rows
- TUI alive vs known split
- Crawl while idle
- `getaddr` on header / filter / block sockets
- New `last_crawled_at` column
- Tor / onion peers

## Success criteria

- Fresh or thin DB: DNS still bootstraps; crawl then adds addresses from live peers.
- Restart: existing rows remain; crawl continues from the probe loop when not idle.
- A peer that handshakes but never sends `addr` stays `alive`.
- `bun test` and `bun run typecheck` pass.
