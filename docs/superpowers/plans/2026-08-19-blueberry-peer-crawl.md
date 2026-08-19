# Peer Crawl (`getaddr`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-phase `getaddr` crawl on top of DNS peer discovery so a good handshake stays alive even when addresses never arrive.

**Architecture:** `probePeer` finishes version/verack under `peerProbeTimeoutMs`, then optionally waits under a new `peerAddrTimeoutMs` for `addr` / `addrv2`. `peers-discovery` sets `wantAddr` on at most one in-flight probe every 15s while not paused. Candidates upsert as today. No deletes.

**Tech Stack:** TypeScript, Bun, `bip324` (`Protocol`, `completeVersionHandshake`, `answerPing`), existing SQLite peers API.

**Spec:** `docs/superpowers/specs/2026-08-19-blueberry-peer-crawl-design.md`

## Global Constraints

- Handshake success never depends on `getaddr`. Addr timeout or empty dump still returns `{ ok: true }`.
- Do not delete, expire, or cap peer rows. No new SQLite columns.
- Crawl only while `peers-discovery` is not paused (`sync:idle` + at least one alive peer).
- One crawl in flight. Minimum 15s between crawl attempts (`peerCrawlIntervalMs`).
- Save every IPv4/IPv6 from collected `addr` / `addrv2` (skip onion / bad port). Stop the addr wait when one payload has 2+ addresses, or when `peerAddrTimeoutMs` fires.
- TUI stays `db.peers.count()`. No header/filter/block socket `getaddr`.
- Do not commit unless the user asks (skip Commit steps until then).
- Prefer a branch that is not `feat/payment-label` for this work.

## File structure

| File | Responsibility |
|------|----------------|
| `src/config.ts` | Add `peerAddrTimeoutMs` (3000) and `peerCrawlIntervalMs` (15000) |
| `src/net/peer-probe.ts` | Two-phase probe: handshake, then optional `getaddr` |
| `src/modules/peers-discovery.ts` | `wantAddr` slot, interval, crawl log |
| `tests/unit/peer-probe.test.ts` | Handshake-only stay green; addr dump; addr timeout |
| `tests/unit/peers-discovery.test.ts` | One crawl at a time; 15s gate; pause; log |

---

### Task 1: Two-phase `probePeer`

**Files:**
- Modify: `src/config.ts`
- Modify: `src/net/peer-probe.ts`
- Test: `tests/unit/peer-probe.test.ts`

**Interfaces:**
- Consumes: `ProbeOptions.connect`, existing `completeVersionHandshake` (already sends `sendaddrv2`).
- Produces:
  - `config.peerAddrTimeoutMs: 3_000`
  - `config.peerCrawlIntervalMs: 15_000` (used in Task 2; add now)
  - `ProbeOptions.wantAddr?: boolean` (default `false`)
  - `ProbeOptions.addrTimeoutMs?: number` (default `config.peerAddrTimeoutMs`)
  - `probePeer` still returns `ProbeResult`. `wantAddr: false` or silent peer → `peers: []`. `wantAddr: true` + dump → parsed candidates. Handshake fail still `{ ok: false }`.

- [ ] **Step 1: Write the failing probe tests**

Keep the existing three tests. Append these tests and a shared responder helper to `tests/unit/peer-probe.test.ts`:

```typescript
import { answerPing } from "bip324";

async function serveHandshake(
  serverSide: Parameters<typeof Protocol.connect>[0],
  afterVerack: (protocol: Protocol) => Promise<void>,
): Promise<void> {
  const protocol = await Protocol.connect(serverSide, {
    role: "responder",
    network: Networks.mainnet,
  });
  const version = await protocol.readMessage();
  if (version.command !== "version") throw new Error("expected version");
  await protocol.writeMessage({
    command: "version",
    payload: {
      version: 70_016,
      services: 1033n,
      timestamp: BigInt(Math.floor(Date.now() / 1_000)),
      receiver: { services: 0n, ip: new Uint8Array(16), port: 8333 },
      sender: { services: 0n, ip: new Uint8Array(16), port: 0 },
      nonce: 1n,
      userAgent: "/test/",
      startHeight: 0,
      relay: false,
    },
  });
  await protocol.writeMessage({ command: "verack" });
  for (;;) {
    const msg = await protocol.readMessage();
    if (msg.command === "verack") break;
    await answerPing(protocol, msg);
  }
  await afterVerack(protocol);
}

test("wantAddr collects addrv2 after handshake and skips onion", async () => {
  const [clientSide, serverSide] = pairedByteDuplexes();
  const server = serveHandshake(serverSide, async (protocol) => {
    for (;;) {
      const msg = await protocol.readMessage();
      if (msg.command === "getaddr") break;
      await answerPing(protocol, msg);
    }
    await protocol.writeMessage({
      command: "addrv2",
      payload: {
        addresses: [
          {
            time: 1,
            services: 0n,
            networkId: 4,
            address: new Uint8Array(32),
            port: 8333,
          },
          {
            time: 1,
            services: 1033n,
            networkId: 1,
            address: Uint8Array.of(1, 2, 3, 4),
            port: 8333,
          },
          {
            time: 1,
            services: 64n,
            networkId: 1,
            address: Uint8Array.of(5, 6, 7, 8),
            port: 8333,
          },
        ],
      },
    });
    await protocol.close();
  });

  const result = await probePeer("127.0.0.1", 8333, {
    timeoutMs: 2_000,
    addrTimeoutMs: 2_000,
    wantAddr: true,
    connect: async () => clientSide,
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.services).toBe(1033n);
    expect(result.peers).toEqual([
      { host: "1.2.3.4", port: 8333, services: 1033n },
      { host: "5.6.7.8", port: 8333, services: 64n },
    ]);
  }
  await server;
});

test("wantAddr timeout after handshake still returns ok with empty peers", async () => {
  const [clientSide, serverSide] = pairedByteDuplexes();
  const server = serveHandshake(serverSide, async (protocol) => {
    await new Promise((r) => setTimeout(r, 200));
    await protocol.close();
  });

  const result = await probePeer("127.0.0.1", 8333, {
    timeoutMs: 2_000,
    addrTimeoutMs: 40,
    wantAddr: true,
    connect: async () => clientSide,
  });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.peers).toEqual([]);
    expect(result.services).toBe(1033n);
  }
  await server;
});
```

Refactor the existing `"succeeds after verack without waiting for getaddr"` body to use `serveHandshake` if that keeps the file smaller. Behavior must stay: `wantAddr` omitted, silent after verack, `ok` + `peers: []`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test tests/unit/peer-probe.test.ts
```

Expected: FAIL — `wantAddr` / `addrTimeoutMs` ignored; no `getaddr`; `peers` stay `[]` or the call type-errors.

- [ ] **Step 3: Add config defaults**

In `src/config.ts`, after `peerProbeTimeoutMs`, add:

```typescript
  /**
   * After a good handshake, how long to wait for addr/addrv2 during a crawl
   * probe. Handshake success does not use this budget. Too low misses dumps;
   * too high holds one crawl socket.
   */
  peerAddrTimeoutMs: 3_000,
  /**
   * Minimum time between getaddr crawl attempts. Discovery runs at most one
   * crawl at a time. Too low chatters; too high grows the book slowly.
   */
  peerCrawlIntervalMs: 15_000,
```

- [ ] **Step 4: Implement two-phase probe**

In `src/net/peer-probe.ts`:

1. Import `answerPing` from `bip324` and `addrV2ToCandidate`, `legacyAddrToCandidate` from `./addr.ts`.
2. Extend `ProbeOptions`:

```typescript
export type ProbeOptions = {
  timeoutMs?: number;
  addrTimeoutMs?: number;
  wantAddr?: boolean;
  connect: TcpConnect;
  handshakeAndGetAddr?: (
    duplex: ProbeDuplex,
    port: number,
  ) => Promise<HandshakeResult>;
};
```

3. Keep `defaultHandshakeAndGetAddr` handshake-only (return `{ peers: [], services }`). Injected `handshakeAndGetAddr` still wins for tests that pass it. The new addr phase runs only on the default handshake path when `wantAddr` is true (injected functions already return `peers` if they want).
4. Split timers in `probePeer`:

```typescript
  const timeoutMs = options.timeoutMs ?? config.peerProbeTimeoutMs;
  const addrTimeoutMs = options.addrTimeoutMs ?? config.peerAddrTimeoutMs;
  const wantAddr = options.wantAddr === true;
  const useDefaultHandshake = options.handshakeAndGetAddr === undefined;
```

Handshake phase: same as today (abort after `timeoutMs`). On success, **clear** that timer. Do not abort the socket yet.

If `useDefaultHandshake && wantAddr`:

- You already have a `Protocol` from the default handshake. Keep it. Do not call `Protocol.connect` twice on the same duplex.
- Easiest: change the default handshake function to return `{ peers, services, protocol }` internally, or inline default handshake in `probePeer` so `protocol` stays in scope.
- Then:

```typescript
await protocol.writeMessage({ command: "getaddr" });
const collected: PeerCandidate[] = [];
let gotDump = false;
const addrDeadline = Date.now() + addrTimeoutMs;

while (!gotDump) {
  const remain = addrDeadline - Date.now();
  if (remain <= 0) break;
  const message = await Promise.race([
    protocol.readMessage(),
    new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), remain);
      t.unref?.();
    }),
  ]);
  if (message === undefined) break;
  if (message.command === "addrv2") {
    for (const row of message.payload.addresses) {
      const peer = addrV2ToCandidate(row);
      if (peer) collected.push(peer);
    }
    if (message.payload.addresses.length >= 2) gotDump = true;
  } else if (message.command === "addr") {
    for (const row of message.payload.addresses) {
      const peer = legacyAddrToCandidate(row);
      if (peer) collected.push(peer);
    }
    if (message.payload.addresses.length >= 2) gotDump = true;
  } else {
    await answerPing(protocol, message);
  }
}
return { ok: true, peers: collected, services };
```

Addr wait errors (read fail / close): still `{ ok: true, peers: collected, services }`.

Finally: close the duplex as today.

Do not let the handshake abort timer fire during the addr wait.

- [ ] **Step 5: Run tests and verify GREEN**

Run:

```bash
bun test tests/unit/peer-probe.test.ts
```

Expected: PASS (4 tests if you kept the original three plus two new; 5 if you kept the original silent test as a fourth plus two new — count must all pass).

- [ ] **Step 6: Commit** (skip unless the user asked)

```bash
git add src/config.ts src/net/peer-probe.ts tests/unit/peer-probe.test.ts
git commit -m "$(cat <<'EOF'
Split peer probe so getaddr cannot fail a good handshake.

EOF
)"
```

---

### Task 2: Discovery crawl slot

**Files:**
- Modify: `src/modules/peers-discovery.ts`
- Test: `tests/unit/peers-discovery.test.ts`

**Interfaces:**
- Consumes: Task 1 `probePeer(..., { wantAddr, addrTimeoutMs })`, `config.peerCrawlIntervalMs`, `config.peerAddrTimeoutMs`.
- Produces:
  - `PeersDiscoveryOptions.probe?: (host: string, port: number, options?: { wantAddr: boolean }) => Promise<ProbeResult>`
  - `PeersDiscoveryOptions.crawlIntervalMs?: number` (default `config.peerCrawlIntervalMs`)
  - `PeersDiscoveryOptions.addrTimeoutMs?: number` (default `config.peerAddrTimeoutMs`) — pass through on the default `probePeer` wrapper
  - At most one spawned probe has `wantAddr: true` at a time
  - `lastCrawlAt` starts as `Number.NEGATIVE_INFINITY` so the first attempt is allowed when `now()` is 0 in tests
  - After a crawl probe settles (ok or fail), set `lastCrawlAt = now()` and clear the in-flight crawl flag
  - Log `[peers-discovery] crawl source=host:port addrs=N` when that crawl probe returns (N is `result.ok ? result.peers.length : 0`)
  - Default `probe` wrapper calls `probePeer` with `wantAddr` and `addrTimeoutMs`

Existing tests that use `probe: async () => ...` stay valid (third argument unused).

- [ ] **Step 1: Write the failing discovery tests**

Append to `tests/unit/peers-discovery.test.ts`:

```typescript
  test("only one crawl probe at a time; interval gates the next", async () => {
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
    db.peers.upsert({
      host: "2.2.2.2",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let t = 0;
    const flags: boolean[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        now: () => t,
        crawlIntervalMs: 15_000,
        concurrency: 2,
        idleDelayMs: 20,
        minAliveCompactFilters: 0,
        probe: async (_host, _port, options) => {
          const want = options?.wantAddr === true;
          flags.push(want);
          if (want) await gate;
          return { ok: false, error: "skip" };
        },
      },
    );

    await mod.start();
    await waitFor(() => flags.length >= 2);
    expect(flags.filter((f) => f).length).toBe(1);
    release();
    await waitFor(() => flags.length >= 3);
    expect(flags.filter((f) => f).length).toBe(1);
    t = 15_000;
    await waitFor(() => flags.filter((f) => f).length >= 2);
    await mod.stop();
    db.close();
  });

  test("logs crawl source and addr count", async () => {
    const file = openTempFileLog();
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

    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
        crawlIntervalMs: 15_000,
        probe: async (_host, _port, options) => {
          if (options?.wantAddr) {
            return {
              ok: true,
              services: 64n,
              peers: [{ host: "9.9.9.9", port: 8333, services: 1033n }],
            };
          }
          return { ok: false, error: "skip" };
        },
      },
    );

    await mod.start();
    await waitFor(() => db.peers.list().some((p) => p.host === "9.9.9.9"));
    await mod.stop();
    const text = file.read();
    file.close();
    db.close();
    expect(text).toContain("[peers-discovery] crawl source=8.8.8.8:8333 addrs=1");
  });

  test("sync:idle does not start a crawl", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: Date.now(),
    });

    const flags: boolean[] = [];
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        concurrency: 1,
        idleDelayMs: 20,
        probeTimeoutMs: 60_000,
        minAliveCompactFilters: 0,
        crawlIntervalMs: 1,
        probe: async (_host, _port, options) => {
          flags.push(options?.wantAddr === true);
          return { ok: false, error: "no" };
        },
      },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 80));
    await mod.stop();
    db.close();
    expect(flags.every((f) => f === false) || flags.length === 0).toBe(true);
  });
```

The idle test must not flake if one probe already started before `sync:idle`. Emit idle **before** `start()` if that is more stable:

```typescript
    await mod.start();
```

Change to: create the module, `bus.emit("sync:idle", { at: Date.now() })`, then `await mod.start()`, wait 80ms, expect `flags` empty (paused immediately because an alive peer exists). Prefer that variant:

```typescript
    bus.emit("sync:idle", { at: Date.now() });
    await mod.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(flags).toEqual([]);
```

`refreshPause` runs on the `sync:idle` listener registered in `start()`, so emit **after** start, then wait. If a probe sneaks in, assert no `wantAddr: true` after pause (use a timestamp: after idle, wait, then check no new `true`). Use the emit-after-start version from the first idle test in this file as the pattern: start, wait one probe, emit idle, wait, expect flags after idle have no extra crawl. Simplest stable form:

Start → emit idle immediately → wait 80ms → `expect(flags.filter(Boolean)).toEqual([])`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
bun test tests/unit/peers-discovery.test.ts --test-name-pattern 'only one crawl|logs crawl|does not start a crawl'
```

Expected: FAIL — `probe` is called with two args; `options` is undefined; no crawl log.

- [ ] **Step 3: Implement the crawl slot**

In `src/modules/peers-discovery.ts`:

Change options and default probe:

```typescript
export type ProbeCallOptions = { wantAddr: boolean };

export type PeersDiscoveryOptions = {
  net: PlatformNet;
  resolveSeeds?: () => Promise<PeerCandidate[]>;
  probe?: (
    host: string,
    port: number,
    options?: ProbeCallOptions,
  ) => Promise<ProbeResult>;
  concurrency?: number;
  idleDelayMs?: number;
  probeTimeoutMs?: number;
  addrTimeoutMs?: number;
  crawlIntervalMs?: number;
  now?: () => number;
  minAliveCompactFilters?: number;
  reseedIntervalMs?: number;
};
```

```typescript
  const addrTimeoutMs = options.addrTimeoutMs ?? config.peerAddrTimeoutMs;
  const crawlIntervalMs = options.crawlIntervalMs ?? config.peerCrawlIntervalMs;
  const probe =
    options.probe ??
    ((host, p, call) =>
      probePeer(host, p, {
        timeoutMs: probeTimeoutMs,
        addrTimeoutMs,
        wantAddr: call?.wantAddr === true,
        connect: options.net.connect,
      }));
```

State:

```typescript
  let lastCrawlAt = Number.NEGATIVE_INFINITY;
  let crawlInFlight = false;
```

Before `probe(...)` in the spawn closure, decide:

```typescript
        const wantAddr =
          !paused &&
          !crawlInFlight &&
          now() - lastCrawlAt >= crawlIntervalMs;
        if (wantAddr) crawlInFlight = true;
        void (async () => {
          try {
            const result = await probe(next.host, next.port, { wantAddr });
            // existing markProbed / upsert / markAlive
            if (wantAddr) {
              const n = result.ok ? result.peers.length : 0;
              log(
                "peers-discovery",
                `crawl source=${key} addrs=${n}`,
              );
            }
            // ...
          } finally {
            if (wantAddr) {
              crawlInFlight = false;
              lastCrawlAt = now();
            }
            // existing inflight.delete / emitSockets / kick
          }
        })();
```

Do not set `wantAddr` when `paused` is already true at spawn time. After `sync:idle`, `runLoop` must not spawn (existing pause branch).

Keep `for (const peer of result.peers) upsertCandidate(peer)` on success.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
bun test tests/unit/peers-discovery.test.ts tests/unit/peer-probe.test.ts
```

Expected: PASS.

- [ ] **Step 5: Typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit** (skip unless the user asked)

```bash
git add src/modules/peers-discovery.ts tests/unit/peers-discovery.test.ts
git commit -m "$(cat <<'EOF'
Rate-limit getaddr crawl to one probe every 15s.

EOF
)"
```

---

## Self-review

| Spec item | Task |
|-----------|------|
| Two-phase probe, handshake 3s, addr 3s | Task 1 |
| Silent / timeout `getaddr` still `ok` | Task 1 |
| Parse `addr` / `addrv2`, skip onion | Task 1 |
| One crawl in flight, 15s interval | Task 2 |
| Upsert candidates, no purge, no new columns | Task 2 (existing upsert) |
| Crawl log `source=host:port addrs=N` | Task 2 |
| Pause: no crawl | Task 2 |
| Failed handshake consumes crawl slot | Task 2 (`lastCrawlAt` in `finally`) |
| Config knobs | Task 1 |
| TUI / schema / idle crawl / sync-socket getaddr | Out of scope — no task |
