# blueberry chain headers sync & validation design

Date: 2026-08-01  
Status: approved (conversation)

## Goal

Implement mainnet chain-header sync: take peers from SQLite, find an alive one, download headers over BIP-324, validate with `bitcoin-headers`, persist them, and show progress in the TUI. New headers must build on a hardcoded checkpoint at height **550000** defined outside the module (to become configurable later).

## Decisions

| Topic | Choice |
|-------|--------|
| Architecture | Module + net helper + typed SQLite headers (Approach A) |
| Checkpoint | Hardcoded height 550000 in `src/checkpoint.ts` (outside module) |
| Peer selection | `db.peers.listAlive()`; wait on `peers:updated` until ≥1 alive |
| Concurrency | Sequential — one peer session at a time |
| Dead peer | Session-local skip; do **not** clear DB `alive` |
| Exhausted peers | Restart from beginning of alive list |
| Timeout | Same `config.peerProbeTimeoutMs` as peer probe |
| Progress total | Highest peer `startHeight` seen (handshake) |
| At tip | Keep polling periodically with `getheaders` |
| Reorgs | Full support via `HeaderBranchBuilder` + `replaceAfter` |
| Inter-module communication | Bus only |

## Architecture

```
main
 ├── MessageBus (EventMap + headers:progress)
 ├── SqliteDatabase (peers + headers)
 ├── checkpoint.ts              # trusted seed OUTSIDE chain-headers
 └── modules.start()
      ├── tui                  # headers:progress → progress store → tile
      ├── peers-discovery      # unchanged
      ├── chain-headers        # sync loop
      └── …other scaffolds
```

**Core pieces**

- `src/checkpoint.ts` — height, header bytes, display hash, pre-checkpoint timestamps, consensus params
- `net/header-sync.ts` — connect, handshake, `getheaders` / `headers` (injectable for tests)
- `modules/chain-headers.ts` — peer rotation, validate, persist, emit progress
- `db` — typed `headers` repository
- TUI — `headers-progress-store` + Chain tip sync tile (bar, event time, ETA)

## Project layout

```
src/
  checkpoint.ts                 # NEW — hardcoded 550000 seed + consensus
  bus/types.ts                  # + headers:progress
  db/
    types.ts                    # + Header / HeadersRepository
    schema.ts                   # + headers table
    sqlite-database.ts          # headers API
  net/
    header-sync.ts              # NEW — getheaders session helper
  modules/
    chain-headers.ts            # real sync (replaces scaffold)
  tui/
    headers-progress-store.ts   # NEW
    use-headers-progress.ts     # NEW
    tui-module.ts               # subscribe headers:progress
    components/ChainTipSync.tsx # progress bar, time, ETA
```

## Checkpoint

Hardcoded outside the module in `src/checkpoint.ts`:

- Height `550000`
- Full 80-byte mainnet header (hex) + display hash
- Exactly 10 preceding timestamps (MTP window for `bitcoin-headers`)
- `HeaderConsensusParams` matching mainnet rules but with this checkpoint (not the package default `665280`)

On module start / DB init: if `headers` is empty, seed the checkpoint row; if non-empty, the first row must match the checkpoint (else fail fast / corruption).

Later this file is the configuration hook; no env/config wiring in this pass.

## Headers model

Table `headers`:

| Column | Type | Meaning |
|--------|------|---------|
| `height` | INTEGER PRIMARY KEY | contiguous from checkpoint |
| `hash_display` | TEXT NOT NULL | big-endian block hash hex |
| `hash_internal_hex` | TEXT NOT NULL | internal byte-order hash hex |
| `header_hex` | TEXT NOT NULL | 80-byte header hex |

```ts
type HeaderRecord = {
  height: number;
  hashDisplay: string;
  hashInternalHex: string;
  headerHex: string;
};

interface HeadersRepository {
  ensureCheckpoint(checkpoint: HeaderRecord): void;
  tip(): HeaderRecord | null;
  count(): number;
  loadAll(): HeaderRecord[];
  loadFrom(height: number): HeaderRecord[];
  append(headers: HeaderRecord[]): void;
  replaceAfter(commonAncestorHeight: number, headers: HeaderRecord[]): void;
}
```

`Database` gains `headers: HeadersRepository` alongside `peers`.

## Sync loop

**On `chain-headers` start**

1. Emit `module:status` `starting`.
2. `ensureCheckpoint` from `src/checkpoint.ts`.
3. Emit `running`.
4. Enter loop (until `stop`).

**Wait for peers**

- If `listAlive()` is empty: subscribe/wait on `peers:updated` until at least one alive peer exists (also re-check on each wake).

**Peer walk**

- Maintain an index into the current alive list and a session-local `dead` set.
- Pick next alive peer not in `dead`.
- On connect/handshake/timeout/protocol/consensus failure for that peer: add to `dead`, try next.
- When no candidates remain: clear `dead`, restart from the beginning of `listAlive()`.
- Do not mutate peer `alive` in the DB.

**Download session (sequential)**

1. Connect with `peerProbeTimeoutMs` (same constant / config as peers-discovery).
2. Version handshake; record peer `startHeight`; if `startHeight > checkpointHeight`, set `maxPeerStartHeight = max(prev, startHeight)`.
3. Build locator from local tip + sparse ancestors; send `getheaders` (stop hash = zeros).
4. Read `headers` batch (Bitcoin allows up to 2000).
5. Validate against loaded canonical chain using `bitcoin-headers`:
   - Extension from tip → append after validation
   - Competing branch → `HeaderBranchBuilder`; if more work, `replaceAfter(commonAncestorHeight, headers)`
6. On successful persist of an applied batch (append or reorg replace): emit `headers:progress`.
7. If batch non-empty and still behind `maxPeerStartHeight`, continue with same peer (or re-pick if session dropped).
8. If empty batch (or local tip ≥ max peer height): enter poll delay (~30s, injectable), then resume (refresh alive list / max height as new handshakes occur).

**Networking**

- Mainnet via `bip324` `Networks.mainnet`.
- Prefer existing TCP/BIP-324 connect path (`connectNodeTcp` / Protocol), shared timeout pattern with `peer-probe`.
- Injectable connect / request functions for tests.

## Bus & TUI

```ts
type EventMap = {
  "app:started": { at: number };
  "module:status": { module: string; status: ModuleStatus; detail?: string };
  "peers:updated": { at: number };
  "headers:progress": {
    at: number;
    downloaded: number; // tipHeight - checkpointHeight
    total: number;      // max(0, maxPeerStartHeight - checkpointHeight)
  };
};
```

Emit `headers:progress` only after a successful validated persist of an applied batch (append or reorg). Do not emit for checkpoint seeding alone or for empty `headers` responses. Until the first progress event, the TUI store stays at `downloaded: 0`, `total: 0`.

**Progress semantics**

- `downloaded` = local `tipHeight - checkpointHeight`
- `total` = `max(0, maxPeerStartHeight - checkpointHeight)` (`maxPeerStartHeight` only advances when a peer advertises `startHeight > checkpointHeight`)
- UI percent = `total === 0 ? 0 : min(100, floor(100 * downloaded / total))`

**TUI behavior**

- `headers-progress-store` holds latest progress + a small history of `{ at, downloaded }` samples.
- TUI module: on `headers:progress`, update the store.
- Chain tip sync tile:
  - Progress bar from `downloaded` / `total`
  - Timestamp of last progress event
  - ETA once ≥2 samples with strictly increasing `downloaded` (linear extrapolation from recent rate); otherwise “—” / hidden

**Lifecycle**

- `main` passes `peerProbeTimeoutMs` into `createChainHeadersModule` (same config field as peers-discovery).
- Start order unchanged (TUI first).
- `stop()` cancels waiters / in-flight session (best-effort close).

## Error handling

- Per-peer timeouts and handshake failures are normal; session-skip and continue.
- Invalid header batch: do not persist; session-skip that peer.
- SQLite open/migrate failure at boot: fail fast (unchanged).
- Bus handler errors remain isolated.

## Testing

- Headers repository unit tests on `:memory:` SQLite: ensureCheckpoint, append, tip, count, replaceAfter.
- Sync unit tests with fake header downloader / peer list:
  - waits for alive peers via `peers:updated`
  - rotates on timeout
  - wraps when all session-dead
  - emits progress with max `startHeight`-based total
  - append path and reorg `replaceAfter` path
- Progress store / ETA unit tests.
- No live mainnet in CI; checkpoint bytes are fixtures in `src/checkpoint.ts`.

## Success criteria

- Fresh DB seeds header 550000; sync only builds on top of it.
- With alive peers, headers accumulate; each successful persist emits `headers:progress`.
- TUI shows progress bar, last event time, and ETA after enough samples.
- Dead peer → next alive; exhausted list → restart from beginning.
- Timeout matches peer probe config.
- `bun test` and `bun run typecheck` pass.

## Out of scope

- Making the checkpoint configurable via env/UI (file is the future hook only)
- Clearing or setting peer `alive` / `used_for_blocks` from this module
- Concurrent multi-peer header download
- Filter / block download pipelines
- Copying a prior store/engine wholesale
