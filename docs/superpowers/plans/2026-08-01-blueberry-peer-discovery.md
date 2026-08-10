# blueberry Peer Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace KV storage with typed SQLite, implement continuous mainnet peer discovery (DNS or alive-peer bootstrap → BIP-324 `getaddr` crawl), and show live peer counts in the TUI Peers tile via DB reads on `peers:updated`.

**Architecture:** `main` opens a Bun SQLite `Database` with a typed `peers` API and injects it as `ModuleContext.db`. `peers-discovery` runs a rate-limited crawl loop (injectable DNS + probe for tests), persists peers, and emits `peers:updated`. The TUI module reads `db.peers.count()` once at start and again on each event.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bip324` / `bip324/node`, existing MessageBus + OpenTUI React tiles. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-01-blueberry-peer-discovery-design.md` exactly.
- Mainnet only; continuous rate-limited crawl on the JS event loop.
- Typed SQLite only — delete generic KV `Storage` / `MemoryStorage`.
- `alive` means successfully used as a peer-discovery bootstrap source; failed probes update `last_probed_at` only (never clear `alive`).
- `peers:updated` payload is `{ at: number }` only; TUI always reads the DB for the count.
- Modules never import each other; communicate via bus + injected `db`.
- Do not copy from other codebases. Reimplement needed DNS/handshake helpers under `src/net/` (inspired by `bip324` examples is fine; do not import `bip324/examples`).
- Commits: only when the user explicitly asks (skip Commit steps unless asked).
- Keep other domain modules as status-only scaffolds.

## File structure

| Path | Responsibility |
|------|----------------|
| `src/db/types.ts` | `Peer`, `Database`, `PeersRepository` |
| `src/db/schema.ts` | DDL + `migrate(db)` |
| `src/db/sqlite-database.ts` | `createSqliteDatabase(path)` |
| `src/bus/types.ts` | Add `peers:updated` |
| `src/modules/types.ts` | `ModuleContext.db` replaces `storage` |
| `src/net/dns-seeds.ts` | Mainnet seeds + `resolveSeedPeers` |
| `src/net/peer-probe.ts` | BIP-324 probe → discovered candidates |
| `src/modules/peers-discovery.ts` | Crawl module |
| `src/tui/peer-count-store.ts` | External store for peer count |
| `src/tui/use-peer-count.ts` | React hook |
| `src/tui/tui-module.ts` | Subscribe + initial DB read |
| `src/tui/components/Peers.tsx` | Show count |
| `src/main.tsx` | Open SQLite, pass `db`, close on shutdown |
| `tests/sqlite-peers.test.ts` | Peer repo tests |
| `tests/dns-seeds.test.ts` | DNS helper tests |
| `tests/peer-probe.test.ts` | Probe unit tests with fake session |
| `tests/peers-discovery.test.ts` | Bootstrap choice + crawl with fakes |
| Delete | `src/storage/**`, `tests/memory-storage.test.ts` |

---

### Task 1: Typed SQLite peers repository (TDD)

**Files:**
- Create: `src/db/types.ts`
- Create: `src/db/schema.ts`
- Create: `src/db/sqlite-database.ts`
- Test: `tests/sqlite-peers.test.ts`
- Modify: `.gitignore` (add `/data/`)

**Interfaces:**
- Consumes: `bun:sqlite`
- Produces: `Peer`; `Database` with `peers.upsert/list/count/listAlive/markProbed/markAlive` and `close()`; `createSqliteDatabase(path: string): Database`

- [ ] **Step 1: Ignore DB directory**

Append to `.gitignore`:

```
/data/
```

- [ ] **Step 2: Write failing peer-repo tests**

Create `tests/sqlite-peers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";

function basePeer(
  overrides: Partial<{
    host: string;
    port: number;
    services: bigint;
    alive: boolean;
    usedForBlocks: boolean;
    lastProbedAt: number | null;
  }> = {},
) {
  return {
    host: "1.2.3.4",
    port: 8333,
    services: 0n,
    alive: false,
    usedForBlocks: false,
    lastProbedAt: null as number | null,
    ...overrides,
  };
}

describe("SqliteDatabase peers", () => {
  test("count is 0 on empty db", () => {
    const db = createSqliteDatabase(":memory:");
    expect(db.peers.count()).toBe(0);
    db.close();
  });

  test("upsert then list/count round-trip", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert(basePeer({ services: 2049n }));
    expect(db.peers.count()).toBe(1);
    const [peer] = db.peers.list();
    expect(peer?.host).toBe("1.2.3.4");
    expect(peer?.port).toBe(8333);
    expect(peer?.services).toBe(2049n);
    expect(peer?.alive).toBe(false);
    expect(peer?.usedForBlocks).toBe(false);
    expect(peer?.lastProbedAt).toBeNull();
    expect(typeof peer?.createdAt).toBe("number");
    expect(typeof peer?.updatedAt).toBe("number");
    db.close();
  });

  test("upsert same host/port updates row without duplicating", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert(basePeer({ services: 1n }));
    const first = db.peers.list()[0]!;
    db.peers.upsert(basePeer({ services: 9n, alive: true }));
    expect(db.peers.count()).toBe(1);
    const second = db.peers.list()[0]!;
    expect(second.services).toBe(9n);
    expect(second.alive).toBe(true);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    db.close();
  });

  test("listAlive returns only alive peers", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert(basePeer({ host: "1.1.1.1", alive: true }));
    db.peers.upsert(basePeer({ host: "2.2.2.2", alive: false }));
    expect(db.peers.listAlive().map((p) => p.host)).toEqual(["1.1.1.1"]);
    db.close();
  });

  test("markProbed and markAlive update fields", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert(basePeer());
    db.peers.markProbed("1.2.3.4", 8333, 1000);
    db.peers.markAlive("1.2.3.4", 8333, true);
    const peer = db.peers.list()[0]!;
    expect(peer.lastProbedAt).toBe(1000);
    expect(peer.alive).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

Run:

```bash
bun test tests/sqlite-peers.test.ts
```

Expected: FAIL (cannot resolve `createSqliteDatabase`).

- [ ] **Step 4: Implement db types, schema, sqlite wrapper**

Create `src/db/types.ts`:

```ts
export type Peer = {
  host: string;
  port: number;
  services: bigint;
  alive: boolean;
  usedForBlocks: boolean;
  lastProbedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PeerWrite = Omit<Peer, "createdAt" | "updatedAt"> &
  Partial<Pick<Peer, "createdAt" | "updatedAt">>;

export interface PeersRepository {
  upsert(peer: PeerWrite): void;
  list(): Peer[];
  count(): number;
  listAlive(): Peer[];
  markProbed(host: string, port: number, at: number): void;
  markAlive(host: string, port: number, alive: boolean): void;
}

export interface Database {
  peers: PeersRepository;
  close(): void;
}
```

Create `src/db/schema.ts`:

```ts
import type { Database as BunDatabase } from "bun:sqlite";

export function migrate(raw: BunDatabase): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      services TEXT NOT NULL DEFAULT '0',
      alive INTEGER NOT NULL DEFAULT 0,
      used_for_blocks INTEGER NOT NULL DEFAULT 0,
      last_probed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host, port)
    );
  `);
}
```

Create `src/db/sqlite-database.ts`:

```ts
import { Database as BunDatabase } from "bun:sqlite";
import { migrate } from "./schema.ts";
import type { Database, Peer, PeerWrite, PeersRepository } from "./types.ts";

type PeerRow = {
  host: string;
  port: number;
  services: string;
  alive: number;
  used_for_blocks: number;
  last_probed_at: number | null;
  created_at: number;
  updated_at: number;
};

function rowToPeer(row: PeerRow): Peer {
  return {
    host: row.host,
    port: row.port,
    services: BigInt(row.services),
    alive: row.alive === 1,
    usedForBlocks: row.used_for_blocks === 1,
    lastProbedAt: row.last_probed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSqliteDatabase(path: string): Database {
  const raw = new BunDatabase(path);
  raw.exec("PRAGMA journal_mode = WAL;");
  migrate(raw);

  const peers: PeersRepository = {
    upsert(peer: PeerWrite) {
      const now = Date.now();
      const createdAt = peer.createdAt ?? now;
      const updatedAt = peer.updatedAt ?? now;
      raw
        .query(
          `INSERT INTO peers (
            host, port, services, alive, used_for_blocks,
            last_probed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(host, port) DO UPDATE SET
            services = excluded.services,
            alive = excluded.alive,
            used_for_blocks = excluded.used_for_blocks,
            last_probed_at = excluded.last_probed_at,
            updated_at = excluded.updated_at`,
        )
        .run(
          peer.host,
          peer.port,
          peer.services.toString(),
          peer.alive ? 1 : 0,
          peer.usedForBlocks ? 1 : 0,
          peer.lastProbedAt,
          createdAt,
          updatedAt,
        );
    },

    list() {
      const rows = raw
        .query("SELECT * FROM peers ORDER BY host, port")
        .all() as PeerRow[];
      return rows.map(rowToPeer);
    },

    count() {
      const row = raw.query("SELECT COUNT(*) AS n FROM peers").get() as {
        n: number;
      };
      return row.n;
    },

    listAlive() {
      const rows = raw
        .query(
          "SELECT * FROM peers WHERE alive = 1 ORDER BY host, port",
        )
        .all() as PeerRow[];
      return rows.map(rowToPeer);
    },

    markProbed(host, port, at) {
      raw
        .query(
          `UPDATE peers
           SET last_probed_at = ?, updated_at = ?
           WHERE host = ? AND port = ?`,
        )
        .run(at, Date.now(), host, port);
    },

    markAlive(host, port, alive) {
      raw
        .query(
          `UPDATE peers
           SET alive = ?, updated_at = ?
           WHERE host = ? AND port = ?`,
        )
        .run(alive ? 1 : 0, Date.now(), host, port);
    },
  };

  return {
    peers,
    close() {
      raw.close();
    },
  };
}
```

**Upsert note:** Callers that only learn a new address should pass `alive: false` and existing `lastProbedAt` if re-upserting known peers carefully. For discovered addresses from `getaddr`, upsert with `alive: false`, `usedForBlocks: false`, `lastProbedAt: null` — but on conflict this would wipe `alive`. Fix in implementation: on conflict, preserve `alive`, `used_for_blocks`, and `last_probed_at` unless the incoming write intentionally sets them via dedicated mark methods.

Replace the `ON CONFLICT` clause with:

```sql
ON CONFLICT(host, port) DO UPDATE SET
  services = excluded.services,
  updated_at = excluded.updated_at
```

And document: `alive` / `used_for_blocks` / `last_probed_at` change only via `markAlive` / future setters / `markProbed`, or via first insert defaults from the upsert payload. For first insert, use the provided flags; on conflict, only refresh `services` + `updated_at`.

Update the upsert SQL in `sqlite-database.ts` accordingly. Adjust the “upsert same host/port” test: second upsert with `alive: true` should **not** flip alive via upsert — use `markAlive` instead:

```ts
  test("upsert same host/port updates services without duplicating or clearing alive", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert(basePeer({ services: 1n }));
    db.peers.markAlive("1.2.3.4", 8333, true);
    const first = db.peers.list()[0]!;
    db.peers.upsert(basePeer({ services: 9n, alive: false }));
    expect(db.peers.count()).toBe(1);
    const second = db.peers.list()[0]!;
    expect(second.services).toBe(9n);
    expect(second.alive).toBe(true);
    expect(second.createdAt).toBe(first.createdAt);
    db.close();
  });
```

- [ ] **Step 5: Run tests — expect PASS**

Run:

```bash
bun test tests/sqlite-peers.test.ts
```

Expected: all pass.

- [ ] **Step 6: Commit (only if user asked)**

```bash
git add .gitignore src/db tests/sqlite-peers.test.ts
git commit -m "$(cat <<'EOF'
Add typed SQLite peers repository.

EOF
)"
```

---

### Task 2: Swap ModuleContext to `db`; delete KV storage

**Files:**
- Modify: `src/modules/types.ts`
- Modify: `src/main.tsx`
- Modify: all scaffold module files only if they reference `storage` (they should not)
- Delete: `src/storage/types.ts`, `src/storage/memory-storage.ts`, `tests/memory-storage.test.ts`

**Interfaces:**
- Consumes: `Database` from `src/db/types.ts`
- Produces: `ModuleContext = { bus, db }`; app boots with SQLite file `./data/blueberry.sqlite`

- [ ] **Step 1: Update module types**

Replace `src/modules/types.ts` with:

```ts
import type { MessageBus } from "../bus/types.ts";
import type { Database } from "../db/types.ts";

export interface ModuleContext {
  bus: MessageBus;
  db: Database;
}

export interface Module {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}
```

- [ ] **Step 2: Ensure data directory + wire main to SQLite**

In `src/main.tsx`:

- Import `mkdirSync` from `node:fs` and `createSqliteDatabase`.
- `mkdirSync("./data", { recursive: true })`.
- `const db = createSqliteDatabase("./data/blueberry.sqlite")`.
- `const ctx = { bus, db }`.
- Remove `createMemoryStorage` import/usage.
- In `shutdown`, after `stopModules()`, call `db.close()` before `renderer.destroy()`.

Keep module list and start order the same.

- [ ] **Step 3: Delete KV storage**

Delete:

- `src/storage/types.ts`
- `src/storage/memory-storage.ts`
- `tests/memory-storage.test.ts`

- [ ] **Step 4: Typecheck + tests**

Run:

```bash
bun run typecheck && bun test
```

Expected: typecheck exit 0; bus + sqlite peer tests pass; no memory-storage tests.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add -A src/modules/types.ts src/main.tsx src/storage tests/memory-storage.test.ts src/db
git commit -m "$(cat <<'EOF'
Replace KV storage with injected SQLite Database.

EOF
)"
```

---

### Task 3: Add `peers:updated` bus event

**Files:**
- Modify: `src/bus/types.ts`
- Modify: `tests/message-bus.test.ts` (optional one-liner coverage)

**Interfaces:**
- Produces: `EventMap["peers:updated"] = { at: number }`

- [ ] **Step 1: Extend EventMap**

In `src/bus/types.ts`, add:

```ts
  "peers:updated": { at: number };
```

- [ ] **Step 2: Add bus test**

Append to `tests/message-bus.test.ts`:

```ts
  test("delivers peers:updated", () => {
    const bus = createMessageBus();
    const seen: number[] = [];
    bus.on("peers:updated", (p) => seen.push(p.at));
    bus.emit("peers:updated", { at: 99 });
    expect(seen).toEqual([99]);
  });
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/message-bus.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit (only if user asked)**

```bash
git add src/bus/types.ts tests/message-bus.test.ts
git commit -m "$(cat <<'EOF'
Add peers:updated bus event.

EOF
)"
```

---

### Task 4: DNS seeds helper (TDD)

**Files:**
- Create: `src/net/dns-seeds.ts`
- Test: `tests/dns-seeds.test.ts`

**Interfaces:**
- Consumes: injectable `DnsResolver`
- Produces: `MAINNET_DNS_SEEDS`; `PeerCandidate`; `resolveSeedPeers(seeds, { port, resolver })`

- [ ] **Step 1: Write failing tests**

Create `tests/dns-seeds.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  MAINNET_DNS_SEEDS,
  resolveSeedPeers,
} from "../src/net/dns-seeds.ts";

describe("dns-seeds", () => {
  test("lists mainnet seeds", () => {
    expect(MAINNET_DNS_SEEDS).toContain("seed.bitcoin.sipa.be");
    expect(MAINNET_DNS_SEEDS.length).toBeGreaterThanOrEqual(5);
  });

  test("resolveSeedPeers prefers IPv4 and uses port", async () => {
    const peers = await resolveSeedPeers(["seed.example"], {
      port: 8333,
      resolver: {
        async resolve4() {
          return ["10.0.0.1"];
        },
        async resolve6() {
          return ["2001:db8::1"];
        },
      },
      random: () => 0,
    });
    expect(peers[0]).toEqual({
      host: "10.0.0.1",
      port: 8333,
      services: 0n,
    });
    expect(peers.some((p) => p.host === "2001:db8::1")).toBe(true);
  });

  test("ignores resolver failures per seed", async () => {
    const peers = await resolveSeedPeers(["bad", "good"], {
      port: 8333,
      resolver: {
        async resolve4(host) {
          if (host === "bad") throw new Error("fail");
          return ["9.9.9.9"];
        },
        async resolve6() {
          return [];
        },
      },
    });
    expect(peers).toEqual([
      { host: "9.9.9.9", port: 8333, services: 0n },
    ]);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/dns-seeds.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/net/dns-seeds.ts`**

```ts
export const MAINNET_DNS_SEEDS = Object.freeze([
  "seed.bitcoin.sipa.be",
  "dnsseed.bluematt.me",
  "seed.bitcoin.jonasschnelli.ch",
  "seed.btc.petertodd.net",
  "seed.bitcoin.sprovoost.nl",
  "dnsseed.emzy.de",
  "seed.bitcoin.wiz.biz",
]);

export type PeerCandidate = {
  host: string;
  port: number;
  services: bigint;
};

export type DnsResolver = {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
};

function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

export async function resolveSeedPeers(
  seeds: readonly string[],
  options: {
    port: number;
    resolver: DnsResolver;
    random?: () => number;
  },
): Promise<PeerCandidate[]> {
  const random = options.random ?? Math.random;
  const v4: PeerCandidate[] = [];
  const v6: PeerCandidate[] = [];
  for (const seed of seeds) {
    try {
      const [a, b] = await Promise.all([
        options.resolver.resolve4(seed).catch(() => [] as string[]),
        options.resolver.resolve6(seed).catch(() => [] as string[]),
      ]);
      for (const host of a) {
        v4.push({ host, port: options.port, services: 0n });
      }
      for (const host of b) {
        v6.push({ host, port: options.port, services: 0n });
      }
    } catch {
      // ignore whole-seed failures
    }
  }
  return [...shuffleInPlace(v4, random), ...shuffleInPlace(v6, random)];
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bun test tests/dns-seeds.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/net/dns-seeds.ts tests/dns-seeds.test.ts
git commit -m "$(cat <<'EOF'
Add mainnet DNS seed resolution helper.

EOF
)"
```

---

### Task 5: Peer probe helper (TDD, fake session)

**Files:**
- Create: `src/net/peer-probe.ts`
- Test: `tests/peer-probe.test.ts`

**Interfaces:**
- Consumes: injectable `connect` + handshake/collect functions (default uses `bip324`)
- Produces: `probePeer(host, port, options) → { ok: true, peers: PeerCandidate[] } | { ok: false, error: string }`

Keep the real BIP-324 path in the default implementation; unit tests never hit the network.

- [ ] **Step 1: Write failing tests**

Create `tests/peer-probe.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { probePeer } from "../src/net/peer-probe.ts";

describe("probePeer", () => {
  test("returns discovered peers on success", async () => {
    const result = await probePeer("1.2.3.4", 8333, {
      timeoutMs: 1000,
      connect: async () => ({ close: async () => {} }),
      handshakeAndGetAddr: async () => [
        { host: "5.6.7.8", port: 8333, services: 1033n },
      ],
    });
    expect(result).toEqual({
      ok: true,
      peers: [{ host: "5.6.7.8", port: 8333, services: 1033n }],
    });
  });

  test("returns ok:false on connect failure", async () => {
    const result = await probePeer("1.2.3.4", 8333, {
      timeoutMs: 1000,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
      handshakeAndGetAddr: async () => [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  test("aborts when timeout elapses", async () => {
    const result = await probePeer("1.2.3.4", 8333, {
      timeoutMs: 20,
      connect: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { close: async () => {} };
      },
      handshakeAndGetAddr: async () => [],
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/peer-probe.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/net/peer-probe.ts`**

```ts
import {
  Networks,
  Protocol,
  type Message,
  type NetworkAddress,
  type NetworkAddressV2,
} from "bip324";
import { connectNodeTcp } from "bip324/node";
import type { PeerCandidate } from "./dns-seeds.ts";

export type ProbeDuplex = {
  close(): Promise<void> | void;
};

export type ProbeResult =
  | { ok: true; peers: PeerCandidate[] }
  | { ok: false; error: string };

export type ProbeOptions = {
  timeoutMs?: number;
  connect?: (host: string, port: number) => Promise<ProbeDuplex>;
  handshakeAndGetAddr?: (
    duplex: ProbeDuplex,
    port: number,
  ) => Promise<PeerCandidate[]>;
};

function ipv4BytesToHost(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

function ipv6BytesToHost(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  }
  return groups.map((g) => g.toString(16)).join(":");
}

function addrV2ToCandidate(
  address: NetworkAddressV2,
): PeerCandidate | undefined {
  if (address.port <= 0 || address.port > 65535) return undefined;
  if (address.networkId === 1 && address.address.length === 4) {
    return {
      host: ipv4BytesToHost(address.address),
      port: address.port,
      services: address.services,
    };
  }
  if (address.networkId === 2 && address.address.length === 16) {
    const host = ipv6BytesToHost(address.address);
    if (host === "0:0:0:0:0:0:0:0") return undefined;
    return { host, port: address.port, services: address.services };
  }
  return undefined;
}

function legacyAddrToCandidate(
  address: NetworkAddress & { time: number },
): PeerCandidate | undefined {
  if (address.port <= 0 || address.port > 65535) return undefined;
  const ip = address.ip;
  const mapped = ip.subarray(0, 12).every((b, i) => b === (i < 10 ? 0 : 0xff));
  if (mapped) {
    return {
      host: ipv4BytesToHost(ip.subarray(12)),
      port: address.port,
      services: address.services,
    };
  }
  if (ip.every((b) => b === 0)) return undefined;
  return {
    host: ipv6BytesToHost(ip),
    port: address.port,
    services: address.services,
  };
}

async function answerPing(
  protocol: Protocol,
  message: Message,
): Promise<void> {
  if (message.command === "ping") {
    await protocol.writeMessage({ command: "pong", nonce: message.nonce });
  }
}

async function defaultHandshakeAndGetAddr(
  duplex: ProbeDuplex,
  port: number,
): Promise<PeerCandidate[]> {
  const network = Networks.mainnet;
  const protocol = await Protocol.connect(duplex as never, {
    role: "initiator",
    network,
  });
  const random = crypto.getRandomValues(new Uint8Array(8));
  const nonce = new DataView(random.buffer).getBigUint64(0, true);
  await protocol.writeMessage({
    command: "version",
    payload: {
      version: 70_016,
      services: 0n,
      timestamp: BigInt(Math.floor(Date.now() / 1_000)),
      receiver: { services: 0n, ip: new Uint8Array(16), port },
      sender: { services: 0n, ip: new Uint8Array(16), port: 0 },
      nonce,
      userAgent: "/blueberry:0.0.1/",
      startHeight: 0,
      relay: false,
    },
  });

  let receivedVersion = false;
  let receivedVerack = false;
  while (!receivedVersion || !receivedVerack) {
    const message = await protocol.readMessage();
    if (message.command === "version") {
      receivedVersion = true;
      await protocol.writeMessage({
        command: "opaque",
        type: { kind: "long", command: "sendaddrv2" },
        payload: new Uint8Array(0),
      });
      await protocol.writeMessage({ command: "verack" });
    } else if (message.command === "verack") {
      receivedVerack = true;
    } else {
      await answerPing(protocol, message);
    }
  }

  await protocol.writeMessage({ command: "getaddr" });
  for (;;) {
    const message = await protocol.readMessage();
    if (message.command === "addrv2") {
      return message.payload.addresses
        .map(addrV2ToCandidate)
        .filter((p): p is PeerCandidate => p !== undefined);
    }
    if (message.command === "addr") {
      return message.payload.addresses
        .map(legacyAddrToCandidate)
        .filter((p): p is PeerCandidate => p !== undefined);
    }
    await answerPing(protocol, message);
  }
}

export async function probePeer(
  host: string,
  port: number,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const connect =
    options.connect ??
    (async (h, p) => connectNodeTcp({ host: h, port: p }));
  const handshakeAndGetAddr =
    options.handshakeAndGetAddr ?? defaultHandshakeAndGetAddr;

  let duplex: ProbeDuplex | undefined;
  try {
    const work = (async () => {
      duplex = await connect(host, port);
      const peers = await handshakeAndGetAddr(duplex, port);
      return peers;
    })();

    const peers = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`probe timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    return { ok: true, peers };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await duplex?.close();
    } catch {
      // ignore close errors
    }
  }
}
```

If `Protocol.connect` typing rejects `ProbeDuplex`, cast through `as never` as shown (tests inject mocks and never call the default path).

- [ ] **Step 4: Run — expect PASS**

```bash
bun test tests/peer-probe.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/net/peer-probe.ts tests/peer-probe.test.ts
git commit -m "$(cat <<'EOF'
Add injectable BIP-324 peer probe helper.

EOF
)"
```

---

### Task 6: `peers-discovery` module (TDD)

**Files:**
- Replace: `src/modules/peers-discovery.ts`
- Test: `tests/peers-discovery.test.ts`

**Interfaces:**
- Consumes: `ModuleContext`, `resolveSeedPeers`, `probePeer`, `Database.peers`, bus
- Produces: `createPeersDiscoveryModule(ctx, options?)` with injectable `resolveSeeds`, `probe`, `now`, `concurrency`, `idleDelayMs`

Behavior:

1. `start`: emit status starting/running; if `listAlive().length > 0` skip DNS; else resolve seeds, upsert candidates, emit `peers:updated`.
2. Kick off background loop (do not await forever inside `start` — return after bootstrap kickoff; loop runs via promises).
3. Loop: pick next peer (never probed first, else oldest `last_probed_at`); probe with concurrency limit; on success upsert discovered peers, `markProbed` + `markAlive(true)` on source, emit `peers:updated` when DB changed; on failure `markProbed` only + emit if probed timestamp changed.
4. `stop`: set aborted flag; wait for in-flight probes to finish (or AbortSignal); emit stopped.

- [ ] **Step 1: Write failing tests**

Create `tests/peers-discovery.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createPeersDiscoveryModule } from "../src/modules/peers-discovery.ts";

function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("timeout waiting for condition"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("peers-discovery", () => {
  test("bootstraps from DNS when no alive peers", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const events: number[] = [];
    bus.on("peers:updated", (p) => events.push(p.at));

    let dnsCalls = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        resolveSeeds: async () => {
          dnsCalls++;
          return [{ host: "10.0.0.1", port: 8333, services: 0n }];
        },
        probe: async () => ({ ok: false, error: "skip" }),
        concurrency: 1,
        idleDelayMs: 50,
      },
    );

    await mod.start();
    await waitFor(() => db.peers.count() >= 1);
    expect(dnsCalls).toBe(1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    await mod.stop();
    db.close();
  });

  test("skips DNS when alive peers exist", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "8.8.8.8",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let dnsCalls = 0;
    const discovered: string[] = [];
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        resolveSeeds: async () => {
          dnsCalls++;
          return [];
        },
        probe: async (host) => {
          if (host === "8.8.8.8") {
            return {
              ok: true,
              peers: [{ host: "9.9.9.9", port: 8333, services: 1n }],
            };
          }
          return { ok: false, error: "no" };
        },
        concurrency: 1,
        idleDelayMs: 50,
      },
    );

    await mod.start();
    await waitFor(() => db.peers.list().some((p) => p.host === "9.9.9.9"));
    expect(dnsCalls).toBe(0);
    expect(db.peers.list().find((p) => p.host === "8.8.8.8")?.alive).toBe(
      true,
    );
    discovered.push("ok");
    await mod.stop();
    db.close();
  });

  test("failed probe updates lastProbedAt without clearing alive", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        resolveSeeds: async () => [],
        probe: async () => ({ ok: false, error: "down" }),
        concurrency: 1,
        idleDelayMs: 50,
        now: () => 12345,
      },
    );

    await mod.start();
    await waitFor(
      () => db.peers.list()[0]?.lastProbedAt === 12345,
    );
    expect(db.peers.list()[0]?.alive).toBe(true);
    await mod.stop();
    db.close();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
bun test tests/peers-discovery.test.ts
```

Expected: FAIL (scaffold module has no options / no crawl).

- [ ] **Step 3: Implement `createPeersDiscoveryModule`**

Replace `src/modules/peers-discovery.ts` with:

```ts
import { promises as dns } from "node:dns";
import { Networks } from "bip324";
import {
  MAINNET_DNS_SEEDS,
  resolveSeedPeers,
  type PeerCandidate,
} from "../net/dns-seeds.ts";
import { probePeer, type ProbeResult } from "../net/peer-probe.ts";
import type { Module, ModuleContext } from "./types.ts";

export type PeersDiscoveryOptions = {
  resolveSeeds?: () => Promise<PeerCandidate[]>;
  probe?: (host: string, port: number) => Promise<ProbeResult>;
  concurrency?: number;
  idleDelayMs?: number;
  now?: () => number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function pickNext(
  peers: { host: string; port: number; lastProbedAt: number | null }[],
  inflight: Set<string>,
) {
  const key = (h: string, p: number) => `${h}:${p}`;
  const available = peers.filter((p) => !inflight.has(key(p.host, p.port)));
  available.sort((a, b) => {
    if (a.lastProbedAt === null && b.lastProbedAt !== null) return -1;
    if (a.lastProbedAt !== null && b.lastProbedAt === null) return 1;
    return (a.lastProbedAt ?? 0) - (b.lastProbedAt ?? 0);
  });
  return available[0];
}

export function createPeersDiscoveryModule(
  ctx: ModuleContext,
  options: PeersDiscoveryOptions = {},
): Module {
  const port = Networks.mainnet.defaultPort;
  const resolveSeeds =
    options.resolveSeeds ??
    (() =>
      resolveSeedPeers(MAINNET_DNS_SEEDS, {
        port,
        resolver: dns,
      }));
  const probe = options.probe ?? ((host, p) => probePeer(host, p));
  const concurrency = options.concurrency ?? 3;
  const idleDelayMs = options.idleDelayMs ?? 1000;
  const now = options.now ?? Date.now;

  let stopped = false;
  let loopDone: Promise<void> = Promise.resolve();

  function emitUpdated() {
    ctx.bus.emit("peers:updated", { at: now() });
  }

  function upsertCandidate(candidate: PeerCandidate) {
    ctx.db.peers.upsert({
      host: candidate.host,
      port: candidate.port,
      services: candidate.services,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
  }

  async function bootstrap(): Promise<void> {
    if (ctx.db.peers.listAlive().length > 0) return;
    const seeds = await resolveSeeds();
    for (const candidate of seeds) upsertCandidate(candidate);
    if (seeds.length > 0) emitUpdated();
  }

  async function runLoop(): Promise<void> {
    const inflight = new Set<string>();
    while (!stopped) {
      while (!stopped && inflight.size < concurrency) {
        const next = pickNext(ctx.db.peers.list(), inflight);
        if (!next) break;
        const key = `${next.host}:${next.port}`;
        inflight.add(key);
        void (async () => {
          try {
            const result = await probe(next.host, next.port);
            const probedAt = now();
            ctx.db.peers.markProbed(next.host, next.port, probedAt);
            if (result.ok) {
              for (const peer of result.peers) upsertCandidate(peer);
              ctx.db.peers.markAlive(next.host, next.port, true);
            }
            emitUpdated();
          } finally {
            inflight.delete(key);
          }
        })();
      }
      await sleep(idleDelayMs);
    }
    while (inflight.size > 0) await sleep(10);
  }

  return {
    name: "peers-discovery",
    async start() {
      ctx.bus.emit("module:status", {
        module: "peers-discovery",
        status: "starting",
      });
      stopped = false;
      await bootstrap();
      loopDone = runLoop();
      ctx.bus.emit("module:status", {
        module: "peers-discovery",
        status: "running",
      });
    },
    async stop() {
      stopped = true;
      await loopDone;
      ctx.bus.emit("module:status", {
        module: "peers-discovery",
        status: "stopped",
      });
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
bun test tests/peers-discovery.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/modules/peers-discovery.ts tests/peers-discovery.test.ts
git commit -m "$(cat <<'EOF'
Implement continuous peers-discovery crawl module.

EOF
)"
```

---

### Task 7: TUI peer count (initial read + `peers:updated`)

**Files:**
- Create: `src/tui/peer-count-store.ts`
- Create: `src/tui/use-peer-count.ts`
- Modify: `src/tui/tui-module.ts`
- Modify: `src/tui/components/Peers.tsx`
- Modify: `src/main.tsx` (wire peer-count store)

**Interfaces:**
- Consumes: `db.peers.count()`, `peers:updated`
- Produces: `createPeerCountStore()`; `setActivePeerCountStore`; `usePeerCount(): number`; Peers tile text `${n} peers`

- [ ] **Step 1: Peer count store + hook**

Create `src/tui/peer-count-store.ts`:

```ts
export type PeerCountStore = {
  get(): number;
  set(count: number): void;
  subscribe(listener: () => void): () => void;
};

export function createPeerCountStore(): PeerCountStore {
  let count = 0;
  const listeners = new Set<() => void>();
  return {
    get() {
      return count;
    },
    set(next) {
      count = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

Create `src/tui/use-peer-count.ts`:

```ts
import { useSyncExternalStore } from "react";
import type { PeerCountStore } from "./peer-count-store.ts";

let activeStore: PeerCountStore | null = null;

export function setActivePeerCountStore(store: PeerCountStore): void {
  activeStore = store;
}

export function usePeerCount(): number {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? 0,
    () => store?.get() ?? 0,
  );
}
```

- [ ] **Step 2: Update TUI module**

Replace `src/tui/tui-module.ts` with:

```ts
import type { Module, ModuleContext } from "../modules/types.ts";
import type { PeerCountStore } from "./peer-count-store.ts";
import type { ModuleStatusStore } from "./status-store.ts";

export function createTuiModule(
  ctx: ModuleContext,
  store: ModuleStatusStore,
  peerCountStore: PeerCountStore,
): Module {
  const unsubs: Array<() => void> = [];

  return {
    name: "tui",
    start() {
      unsubs.push(
        ctx.bus.on("module:status", (payload) => {
          store.set(payload.module, {
            status: payload.status,
            detail: payload.detail,
          });
        }),
      );
      peerCountStore.set(ctx.db.peers.count());
      unsubs.push(
        ctx.bus.on("peers:updated", () => {
          peerCountStore.set(ctx.db.peers.count());
        }),
      );
      ctx.bus.emit("module:status", { module: "tui", status: "starting" });
      ctx.bus.emit("module:status", { module: "tui", status: "running" });
    },
    stop() {
      for (const off of unsubs) off();
      unsubs.length = 0;
      ctx.bus.emit("module:status", { module: "tui", status: "stopped" });
    },
  };
}
```

- [ ] **Step 3: Update Peers tile**

```tsx
import { usePeerCount } from "../use-peer-count.ts";

export function Peers() {
  const count = usePeerCount();
  return (
    <box
      title="Peers"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    >
      <text>{count} peers</text>
    </box>
  );
}
```

- [ ] **Step 4: Wire store in `main.tsx`**

- `const peerCountStore = createPeerCountStore()`
- `setActivePeerCountStore(peerCountStore)`
- `createTuiModule(ctx, statusStore, peerCountStore)`

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 6: Commit (only if user asked)**

```bash
git add src/tui src/main.tsx
git commit -m "$(cat <<'EOF'
Show SQLite peer count in TUI Peers tile.

EOF
)"
```

---

### Task 8: Integration verification

**Files:**
- Possibly minor fixes only

- [ ] **Step 1: Run full unit suite**

```bash
bun test && bun run typecheck
```

Expected: all tests pass; typecheck clean.

- [ ] **Step 2: Manual smoke (optional, network)**

```bash
bun start
```

Expected:

- Peers tile starts at `0 peers` (or prior DB count on restart)
- Within ~30–60s on a networked host, count increases as DNS + `getaddr` succeed
- Quit with `q` / SIGINT cleans up without hang
- Restart: if any peer was marked alive, crawl continues without depending on DNS first

- [ ] **Step 3: Spec coverage check**

Confirm each success criterion in the design spec is met by Tasks 1–8.

- [ ] **Step 4: Commit (only if user asked)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Finish peer discovery wiring and verification.

EOF
)"
```

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Typed SQLite peers table + API | Task 1 |
| Remove KV MemoryStorage; inject `db` | Task 2 |
| `peers:updated` event | Task 3 |
| Mainnet DNS seeds bootstrap | Task 4, Task 6 |
| BIP-324 probe / getaddr | Task 5 |
| Skip DNS when alive peers exist | Task 6 |
| Continuous crawl; mark alive/probed | Task 6 |
| Failed probe does not clear alive | Task 6 |
| TUI initial DB read once | Task 7 |
| TUI refresh on `peers:updated` via DB | Task 7 |
| Peers tile shows count | Task 7 |
| DB file `./data/blueberry.sqlite`; fail-fast open | Task 2 |
| Unit tests without live mainnet | Tasks 1, 4, 5, 6 |
| Manual mainnet smoke | Task 8 |
| No copying from other codebases; no headers/blocks yet | All (omitted) |
