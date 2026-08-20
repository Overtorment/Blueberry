import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createPeersDiscoveryModule } from "../../src/modules/peers-discovery.ts";
import { openTempFileLog } from "./file-log-harness.ts";
import { stubPlatformNet } from "./stub-platform-net.ts";

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
  test("emits peers:sockets probe counts while probing", async () => {
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

    const opens: number[] = [];
    bus.on("peers:sockets", (p) => {
      if (p.kind === "probe") opens.push(p.open);
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => {
          await gate;
          return { ok: false, error: "skip" };
        },
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
      },
    );

    await mod.start();
    await waitFor(() => opens.includes(1));
    release();
    await waitFor(() => opens.includes(0) && opens.indexOf(0) > opens.indexOf(1));
    await mod.stop();
    db.close();
  });

  test("DNS bootstrap inserts seed peers and emits peers:updated", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    let updates = 0;
    bus.on("peers:updated", () => {
      updates++;
    });

    let dnsCalls = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => {
          dnsCalls++;
          return [
            { host: "10.0.0.1", port: 8333, services: 0n },
            { host: "10.0.0.2", port: 8333, services: 0n },
          ];
        },
        probe: async () => ({ ok: false, error: "skip" }),
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
      },
    );

    await mod.start();
    await waitFor(() => db.peers.count() === 2);
    expect(dnsCalls).toBe(1);
    expect(updates).toBeGreaterThanOrEqual(1);
    expect(db.peers.listAlive()).toEqual([]);
    await mod.stop();
    db.close();
  });

  test("logs DNS seed count", async () => {
    const file = openTempFileLog();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [
          { host: "10.0.0.1", port: 8333, services: 0n },
          { host: "10.0.0.2", port: 8333, services: 0n },
        ],
        probe: async () => ({ ok: false, error: "skip" }),
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    await waitFor(() => db.peers.count() === 2);
    await mod.stop();
    const text = file.read();
    file.close();
    db.close();
    expect(text).toContain("[peers-discovery] start");
    expect(text).toContain("[peers-discovery] dns seeds=2");
    expect(text).toContain("[peers-discovery] stop");
  });

  test("alive peers skip DNS; successful probe stores neighbors and marks source alive", async () => {
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
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => {
          dnsCalls++;
          return [{ host: "should.not.appear", port: 8333, services: 0n }];
        },
        probe: async (host) => {
          if (host === "8.8.8.8") {
            return {
              ok: true,
              peers: [{ host: "9.9.9.9", port: 8333, services: 1033n }],
              services: 64n,
            };
          }
          return { ok: false, error: "no" };
        },
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
      },
    );

    await mod.start();
    await waitFor(() => db.peers.list().some((p) => p.host === "9.9.9.9"));
    expect(dnsCalls).toBe(0);
    expect(db.peers.list().some((p) => p.host === "should.not.appear")).toBe(
      false,
    );
    const neighbor = db.peers.list().find((p) => p.host === "9.9.9.9");
    expect(neighbor?.services).toBe(1033n);
    expect(neighbor?.alive).toBe(false);
    expect(db.peers.list().find((p) => p.host === "8.8.8.8")?.alive).toBe(
      true,
    );
    expect(db.peers.list().find((p) => p.host === "8.8.8.8")?.services).toBe(
      64n,
    );
    expect(db.peers.list().find((p) => p.host === "8.8.8.8")?.lastProbedAt).not.toBeNull();
    await mod.stop();
    db.close();
  });

  test("re-seeds DNS when alive compact-filter peers are scarce", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    // One alive peer without compact filters — below CF threshold.
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: 1,
    });

    let dnsCalls = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => {
          dnsCalls++;
          return [{ host: "10.0.0.9", port: 8333, services: 0n }];
        },
        probe: async () => ({ ok: false, error: "skip" }),
        concurrency: 1,
        idleDelayMs: 20,
        minAliveCompactFilters: 2,
        reseedIntervalMs: 1,
      },
    );

    await mod.start();
    await waitFor(() => dnsCalls >= 1);
    await waitFor(() => db.peers.list().some((p) => p.host === "10.0.0.9"));
    expect(dnsCalls).toBeGreaterThanOrEqual(1);
    await mod.stop();
    db.close();
  });

  test("DNS reseed does not zero learned service bits on known peers", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 64n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: 1,
    });

    let dnsCalls = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => {
          dnsCalls++;
          return [{ host: "1.1.1.1", port: 8333, services: 0n }];
        },
        probe: async () => ({ ok: false, error: "skip" }),
        concurrency: 1,
        idleDelayMs: 20,
        minAliveCompactFilters: 2,
        reseedIntervalMs: 1,
      },
    );

    await mod.start();
    await waitFor(() => dnsCalls >= 1);
    const peer = db.peers.list().find((p) => p.host === "1.1.1.1");
    expect(peer?.services).toBe(64n);
    expect(db.peers.listWithServices(64n, 10).map((p) => p.host)).toContain(
      "1.1.1.1",
    );
    await mod.stop();
    db.close();
  });

  test("probes known peers while DNS bootstrap is still in flight", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "5.5.5.5",
      port: 8333,
      services: 64n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let probed = false;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: () => new Promise(() => {}),
        probe: async (host) => {
          if (host === "5.5.5.5") probed = true;
          return { ok: false, error: "skip" };
        },
        concurrency: 1,
        idleDelayMs: 20,
        minAliveCompactFilters: 0,
      },
    );

    await mod.start();
    await waitFor(() => probed);
    await mod.stop();
    db.close();
  });

  test("prefers compact-filter candidates when that pool is thin", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    db.peers.upsert({
      host: "2.2.2.2",
      port: 8333,
      services: 64n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: 99,
    });

    const probed: string[] = [];
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async (host) => {
          probed.push(host);
          return { ok: false, error: "skip" };
        },
        concurrency: 1,
        idleDelayMs: 20,
        minAliveCompactFilters: 1,
      },
    );

    await mod.start();
    await waitFor(() => probed.length >= 1);
    expect(probed[0]).toBe("2.2.2.2");
    await mod.stop();
    db.close();
  });

  test("probes never-probed peers even when many dead compact-filter peers exist", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    for (let i = 0; i < 8; i++) {
      db.peers.upsert({
        host: `2.2.2.${i}`,
        port: 8333,
        services: 64n,
        alive: false,
        usedForBlocks: false,
        lastProbedAt: 1,
      });
    }
    db.peers.upsert({
      host: "9.9.9.9",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    const probed: string[] = [];
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async (host) => {
          probed.push(host);
          return { ok: false, error: "skip" };
        },
        concurrency: 4,
        idleDelayMs: 20,
        minAliveCompactFilters: 16,
        now: () => 1_000,
      },
    );

    await mod.start();
    await waitFor(() => probed.includes("9.9.9.9"));
    await mod.stop();
    db.close();
  });

  test("reseeds immediately when compact-filter peers are scarce", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: 1,
    });

    let dnsCalls = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => {
          dnsCalls++;
          return [{ host: "10.0.0.9", port: 8333, services: 0n }];
        },
        probe: async () => ({ ok: false, error: "skip" }),
        concurrency: 1,
        idleDelayMs: 20,
        minAliveCompactFilters: 2,
        reseedIntervalMs: 60_000,
      },
    );

    await mod.start();
    await waitFor(() => dnsCalls >= 1);
    await waitFor(() => db.peers.list().some((p) => p.host === "10.0.0.9"));
    await mod.stop();
    db.close();
  });

  test("probes known peers while DNS reseed is still in flight", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "1.1.1.1",
      port: 8333,
      services: 0n,
      alive: true,
      usedForBlocks: false,
      lastProbedAt: 1,
    });
    db.peers.upsert({
      host: "2.2.2.2",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let probedNever = false;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: () => new Promise(() => {}),
        probe: async (host) => {
          if (host === "2.2.2.2") probedNever = true;
          return { ok: false, error: "skip" };
        },
        concurrency: 1,
        idleDelayMs: 20,
        minAliveCompactFilters: 2,
        reseedIntervalMs: 0,
      },
    );

    await mod.start();
    await waitFor(() => probedNever);
    await mod.stop();
    db.close();
  });

  test("default probe path calls net.connect", async () => {
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

    let connectHost: string | undefined;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: {
          connect: async (host) => {
            connectHost = host;
            throw new Error("ECONNREFUSED");
          },
          dns: stubPlatformNet().dns,
        },
        resolveSeeds: async () => [],
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
      },
    );

    await mod.start();
    await waitFor(() => connectHost === "1.1.1.1");
    await waitFor(() => db.peers.list()[0]?.alive === false);
    await mod.stop();
    db.close();
  });

  test("failed probe updates lastProbedAt and clears alive", async () => {
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
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => ({ ok: false, error: "down" }),
        concurrency: 1,
        idleDelayMs: 50,
        now: () => 12345,
      },
    );

    await mod.start();
    await waitFor(() => db.peers.list()[0]?.lastProbedAt === 12345);
    expect(db.peers.list()[0]?.alive).toBe(false);
    await mod.stop();
    db.close();
  });

  test("logs probe fail with host", async () => {
    const file = openTempFileLog();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "9.9.9.9",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => ({ ok: false, error: "timeout" }),
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    await waitFor(() => db.peers.list()[0]?.lastProbedAt !== null);
    await mod.stop();
    const text = file.read();
    file.close();
    db.close();
    expect(text).toContain("[peers-discovery] probe fail 9.9.9.9:8333 error=timeout");
  });

  test("does not immediately re-probe a peer that just failed", async () => {
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

    let probes = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => {
          probes++;
          return { ok: false, error: "down" };
        },
        concurrency: 1,
        idleDelayMs: 20,
        probeTimeoutMs: 180,
        minAliveCompactFilters: 0,
      },
    );

    await mod.start();
    await waitFor(() => probes >= 1);
    const atFirst = probes;
    await new Promise((r) => setTimeout(r, 40));
    expect(probes).toBe(atFirst);
    await waitFor(() => probes > atFirst);
    await mod.stop();
    db.close();
  });

  test("in-flight probe after stop does not persist results", async () => {
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

    const opens: number[] = [];
    bus.on("peers:sockets", (p) => {
      if (p.kind === "probe") opens.push(p.open);
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => {
          await gate;
          return { ok: false, error: "down" };
        },
        concurrency: 1,
        idleDelayMs: 50,
        now: () => 12345,
        minAliveCompactFilters: 0,
      },
    );

    await mod.start();
    await waitFor(() => opens.includes(1));
    await mod.stop();
    release();
    await new Promise((r) => setTimeout(r, 40));
    expect(db.peers.list()[0]?.lastProbedAt).toBeNull();
    expect(db.peers.list()[0]?.alive).toBe(true);
    db.close();
  });

  test("sync:idle pauses probes; sync:catchup resumes", async () => {
    const file = openTempFileLog();
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
    db.peers.upsert({
      host: "2.2.2.2",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let probes = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => {
          probes++;
          return { ok: false, error: "no" };
        },
        concurrency: 1,
        idleDelayMs: 20,
        probeTimeoutMs: 60_000,
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    await waitFor(() => probes >= 1);
    const atIdle = probes;
    bus.emit("sync:idle", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 80));
    expect(probes).toBe(atIdle);
    db.peers.upsert({
      host: "3.3.3.3",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    bus.emit("sync:catchup", { at: Date.now(), reason: "headers" });
    await waitFor(() => probes > atIdle);
    await mod.stop();
    const text = file.read();
    file.close();
    expect(text).toContain("[peers-discovery] pause");
    expect(text).toContain("[peers-discovery] resume");
    db.close();
  });

  test("sync:idle keeps probing when no peer is alive", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "2.2.2.2",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });

    let probes = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => {
          probes++;
          return { ok: false, error: "offline" };
        },
        concurrency: 1,
        idleDelayMs: 20,
        probeTimeoutMs: 20,
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => probes >= 1);
    await mod.stop();
    db.close();
  });

  test("sync:idle resumes probes after the last alive peer dies", async () => {
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

    let probes = 0;
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => {
          probes++;
          return { ok: false, error: "no" };
        },
        concurrency: 1,
        idleDelayMs: 20,
        probeTimeoutMs: 20,
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    await waitFor(() => probes >= 1);
    bus.emit("sync:idle", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 80));
    const atIdle = probes;
    db.peers.markAlive("1.1.1.1", 8333, false);
    bus.emit("peers:updated", { at: Date.now() });
    await waitFor(() => probes > atIdle);
    await mod.stop();
    db.close();
  });

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
        probeTimeoutMs: 0,
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
    expect(text).toContain(
      "[peers-discovery] crawl source=8.8.8.8:8333 addrs=1",
    );
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
      lastProbedAt: null,
    });

    const flags: boolean[] = [];
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        concurrency: 1,
        idleDelayMs: 20,
        probeTimeoutMs: 0,
        minAliveCompactFilters: 0,
        crawlIntervalMs: 1,
        probe: async (_host, _port, options) => {
          flags.push(options?.wantAddr === true);
          return { ok: true, peers: [], services: 0n };
        },
      },
    );
    await mod.start();
    await waitFor(() => flags.length >= 1);
    const beforeIdle = flags.length;
    expect(flags.slice(0, beforeIdle)).toContain(true);
    bus.emit("sync:idle", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 80));
    expect(flags.slice(beforeIdle).filter(Boolean)).toEqual([]);
    await mod.stop();
    db.close();
  });
});
