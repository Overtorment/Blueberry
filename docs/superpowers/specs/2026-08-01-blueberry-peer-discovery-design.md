# blueberry peer discovery design

Date: 2026-08-01  
Status: approved (conversation)

## Goal

Implement real mainnet peer discovery: bootstrap from DNS seeds (or previously alive peers), continuously crawl the network for peers over BIP-324, persist peers in typed SQLite, and show the peer count in the TUI Peers tile. The TUI refreshes by reading the database when notified (and once on initial launch).

## Decisions

| Topic | Choice |
|-------|--------|
| Network | Mainnet only |
| Persistence | Bun SQLite, typed API — no generic key/value storage |
| Architecture | Typed SQLite facade + crawler in `peers-discovery` (Approach A) |
| Alive meaning | Peer successfully used as a peer-discovery bootstrap source (handshake + useful `getaddr`) |
| Crawl mode | Continuous background crawl while the app runs (rate-limited) |
| TUI data path | Bus event is a refresh signal; TUI reads peer count from DB |
| Concurrency | JS event loop (promises / timers / I/O); no worker threads |
| Inter-module communication | Bus only — modules never import or call each other |

This revises the prior scaffold decision that the TUI never reads storage and that storage is generic KV / in-memory only.

## Architecture

```
main
 ├── MessageBus (typed EventMap)
 ├── SqliteDatabase (typed domain API)
 └── modules.start()
      ├── tui                 # start: count once; on peers:updated: recount
      ├── peers-discovery     # DNS/known bootstrap + continuous crawl
      └── …other scaffolds    # unchanged domain logic
```

**Core pieces**

- `MessageBus` — existing pub/sub; add `peers:updated`
- `Database` — typed SQLite facade injected into every module (replaces `Storage`)
- `peers-discovery` — owns crawl loop; writes peers; emits refresh + module status
- `tui` — subscribes to `peers:updated`, reads `db.peers.count()`, updates Peers tile

## Project layout

```
src/
  main.tsx
  bus/
    types.ts                 # EventMap includes peers:updated
    message-bus.ts
  db/
    types.ts                 # Database, Peer types
    schema.ts                # DDL / migrate
    sqlite-database.ts       # Bun Database wrapper + peers API
  modules/
    peers-discovery.ts       # real crawl module (replaces scaffold)
    …other scaffolds
  net/
    dns-seeds.ts             # mainnet seed list + resolve (injectable resolver)
    peer-probe.ts            # connect, handshake, getaddr (injectable for tests)
  tui/
    tui-module.ts            # also listens for peers:updated
    peer-count-store.ts      # external store for peer count (separate from module status)
    components/Peers.tsx     # shows peer count
```

Remove `src/storage/` KV interface and `MemoryStorage` when `Database` is wired. Existing `MemoryStorage` tests are deleted or replaced by SQLite peer-repo tests. Scaffold modules switch `ModuleContext.storage` → `ModuleContext.db` but otherwise stay status-only.

## Peer model

Table `peers`:

| Column | Type | Meaning |
|--------|------|---------|
| `host` | TEXT | IP or hostname |
| `port` | INTEGER | P2P port |
| `services` | TEXT | service bits as decimal string (`bigint`) |
| `alive` | INTEGER (0/1) | successfully used to bootstrap peer discovery |
| `used_for_blocks` | INTEGER (0/1) | set later by blocks-download; default 0 |
| `last_probed_at` | INTEGER NULL | unix ms of last probe attempt |
| `created_at` | INTEGER | first seen (unix ms) |
| `updated_at` | INTEGER | last row change (unix ms) |

Primary key: `(host, port)`.

```ts
type Peer = {
  host: string;
  port: number;
  services: bigint;
  alive: boolean;
  usedForBlocks: boolean;
  lastProbedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

interface Database {
  peers: {
    upsert(
      peer: Omit<Peer, "createdAt" | "updatedAt"> &
        Partial<Pick<Peer, "createdAt" | "updatedAt">>,
    ): void;
    list(): Peer[];
    count(): number;
    listAlive(): Peer[];
    markProbed(host: string, port: number, at: number): void;
    markAlive(host: string, port: number, alive: boolean): void;
  };
  close(): void;
}
```

Default DB file: `./data/blueberry.sqlite` (directory created on boot). Tests use `:memory:` (or a temp path).

## Bootstrap & crawl

**On `peers-discovery` start**

1. Emit `module:status` `starting` → `running`.
2. If `peers.listAlive()` is non-empty → use those peers as the initial crawl queue (skip DNS).
3. Else → resolve mainnet DNS seeds → upsert candidates with `alive: false` → emit `peers:updated` → crawl from those candidates.

**Steady state (until `stop`)**

- Work queue over known peers; prefer never-probed, then oldest `last_probed_at`.
- Small concurrency (about 2–4 in-flight probes) and timeouts so the loop cannot stall.
- Per successful probe: BIP-324 TCP session → version handshake → `getaddr` → upsert returned peers → mark source `alive: true` and `last_probed_at` → emit `peers:updated`.
- Per failed probe: update `last_probed_at` only; do **not** clear `alive` (headers sync will assess reachability later).
- Emit `peers:updated` whenever a persisted peer row is inserted or changed.

**Networking**

- Mainnet port and magic via `bip324` `Networks.mainnet`.
- DNS seed hostnames match Bitcoin Core’s common mainnet list (same set used by `bip324` examples).
- Prefer IPv4 candidates when both are available.
- Onion / Tor addresses are out of scope (ignore or skip).

## Bus & TUI

```ts
type EventMap = {
  "app:started": { at: number };
  "module:status": {
    module: string;
    status: ModuleStatus;
    detail?: string;
  };
  "peers:updated": { at: number }; // invalidate / refresh signal only
};
```

**TUI behavior**

- On TUI module `start`: read `db.peers.count()` **once** and publish to `peer-count-store`.
- On each `peers:updated`: read `db.peers.count()` again and update the store.
- Peers tile shows only the peer count (e.g. `12 peers`), not module status text.

**Lifecycle**

- `main` constructs bus + SQLite `Database`, creates modules with `{ bus, db }` (rename context field from `storage` → `db`).
- Start order unchanged: TUI first, then domain modules.
- Shutdown: `stop()` modules (cancel crawl / in-flight probes), then `db.close()`.

## Error handling

- Per-peer DNS/connect/handshake/timeout failures are normal; they update `last_probed_at` and continue the crawl.
- If SQLite open or migrate fails at boot, `main` fails fast (throw / exit) — no silent empty DB facade.
- Probe timeouts are hard-bounded.
- Bus handler errors remain isolated (existing MessageBus behavior).

## Testing

- Peer repository unit tests on `:memory:` SQLite: upsert, count, listAlive, markProbed, markAlive.
- Bootstrap choice tests with injectable seed resolver / probe function: empty alive set → DNS path; alive peers present → skip DNS.
- Probe/crawl unit tests against a fake P2P client (no live mainnet in CI).
- Manual smoke: `bun start` against real mainnet accumulates peers and updates the tile.

## Success criteria

- Fresh DB: DNS bootstrap → peers accumulate in SQLite → Peers tile count rises.
- Restart with at least one `alive` peer: crawl begins from DB without requiring DNS.
- Every persisted peer change emits `peers:updated`; TUI refreshes count from DB.
- TUI performs an initial DB count read once at start.
- `bun test` and `bun run typecheck` pass.

## Out of scope

- Headers sync, filter/block download, or using peers for those pipelines
- Clearing `alive` on later failures
- Setting `used_for_blocks`
- Tor / onion peers, scoring, banning, ADDR relay as a server
- Request/response APIs on the bus
- Domain tables for headers/filters/wallet (add when those modules are implemented)
- Copying logic from other codebases
