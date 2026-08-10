import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createPeersDiscoveryModule } from "../../src/modules/peers-discovery.ts";
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

  test("sync:idle pauses probes; sync:catchup resumes", async () => {
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
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    await waitFor(() => probes >= 1);
    const atIdle = probes;
    bus.emit("sync:idle", { at: Date.now() });
    await new Promise((r) => setTimeout(r, 80));
    expect(probes).toBe(atIdle);
    bus.emit("sync:catchup", { at: Date.now(), reason: "headers" });
    await waitFor(() => probes > atIdle);
    await mod.stop();
    db.close();
  });
});
