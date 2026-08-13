import { describe, expect, test } from "bun:test";
import {
  fromSqliteServices,
  toSqliteServices,
} from "../../src/db/peer-services.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

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
  test("services helpers round-trip full unsigned 64-bit range", () => {
    const high = 1n << 63n;
    const max = (1n << 64n) - 1n;
    expect(fromSqliteServices(toSqliteServices(0n))).toBe(0n);
    expect(fromSqliteServices(toSqliteServices(2049n))).toBe(2049n);
    expect(fromSqliteServices(toSqliteServices(high))).toBe(high);
    expect(fromSqliteServices(toSqliteServices(max))).toBe(max);
    expect(toSqliteServices(high)).toBe(-(1n << 63n));
  });

  test("high service bit survives upsert and service filters", () => {
    const db = createSqliteDatabase(":memory:");
    const high = 1n << 63n;
    db.peers.upsert(
      basePeer({ host: "9.9.9.9", services: high | 64n, alive: true }),
    );
    expect(db.peers.list()[0]?.services).toBe(high | 64n);
    expect(
      db.peers.listAliveWithServices(high, 10).map((p) => p.host),
    ).toEqual(["9.9.9.9"]);
    expect(
      db.peers.listWithServices(64n, 10).map((p) => p.host),
    ).toContain("9.9.9.9");
    db.close();
  });

  test("upsert round-trip and count", () => {
    const db = createSqliteDatabase(":memory:");
    expect(db.peers.count()).toBe(0);
    db.peers.upsert(basePeer({ services: 2049n }));
    expect(db.peers.count()).toBe(1);
    const [peer] = db.peers.list();
    expect(peer).toMatchObject({
      host: "1.2.3.4",
      port: 8333,
      services: 2049n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    db.close();
  });

  test("conflict upsert refreshes services without clearing flags", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert(basePeer({ services: 1n }));
    db.peers.markAlive("1.2.3.4", 8333, true);
    db.peers.markProbed("1.2.3.4", 8333, 42);
    db.peers.upsert(
      basePeer({
        services: 9n,
        alive: false,
        usedForBlocks: true,
        lastProbedAt: null,
      }),
    );
    expect(db.peers.count()).toBe(1);
    expect(db.peers.list()[0]).toMatchObject({
      services: 9n,
      alive: true,
      lastProbedAt: 42,
      usedForBlocks: false,
    });
    db.close();
  });

  test("conflict upsert with services 0 preserves known bits", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert(basePeer({ services: 64n, alive: true }));
    db.peers.upsert(basePeer({ services: 0n, alive: false }));
    expect(db.peers.list()[0]).toMatchObject({
      services: 64n,
      alive: true,
    });
    expect(db.peers.listAliveWithServices(64n, 10).map((p) => p.host)).toEqual([
      "1.2.3.4",
    ]);
    db.close();
  });

  test("listAlive and mark helpers", () => {
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert(basePeer({ host: "1.1.1.1", alive: true }));
    db.peers.upsert(basePeer({ host: "2.2.2.2", alive: false }));
    expect(db.peers.listAlive().map((p) => p.host)).toEqual(["1.1.1.1"]);
    db.peers.markProbed("2.2.2.2", 8333, 1000);
    db.peers.markAlive("2.2.2.2", 8333, true);
    expect(db.peers.list().find((p) => p.host === "2.2.2.2")).toMatchObject({
      lastProbedAt: 1000,
      alive: true,
    });
    db.peers.markUsedForBlocks("1.1.1.1", 8333);
    expect(db.peers.list().find((p) => p.host === "1.1.1.1")).toMatchObject({
      usedForBlocks: true,
    });
    db.close();
  });

  test("listAliveWithServices filters by bits and unusedForBlocks", () => {
    const db = createSqliteDatabase(":memory:");
    const NET = 1n;
    db.peers.upsert(
      basePeer({ host: "1.1.1.1", services: NET, alive: true, usedForBlocks: false }),
    );
    db.peers.upsert(
      basePeer({ host: "2.2.2.2", services: NET, alive: true, usedForBlocks: true }),
    );
    db.peers.upsert(
      basePeer({ host: "3.3.3.3", services: 0n, alive: true, usedForBlocks: false }),
    );
    db.peers.upsert(
      basePeer({ host: "4.4.4.4", services: NET, alive: false, usedForBlocks: false }),
    );

    expect(
      db.peers.listAliveWithServices(NET, 10).map((p) => p.host),
    ).toEqual(["1.1.1.1", "2.2.2.2"]);
    expect(
      db.peers
        .listAliveWithServices(NET, 10, { unusedForBlocks: true })
        .map((p) => p.host),
    ).toEqual(["1.1.1.1"]);
    db.close();
  });

  test("listWithServices prefers alive and listProbeQueue orders never-probed first", () => {
    const db = createSqliteDatabase(":memory:");
    const CF = 64n;
    db.peers.upsert(
      basePeer({ host: "1.1.1.1", services: CF, alive: false, lastProbedAt: 10 }),
    );
    db.peers.upsert(
      basePeer({ host: "2.2.2.2", services: CF, alive: true, lastProbedAt: 20 }),
    );
    db.peers.upsert(
      basePeer({ host: "3.3.3.3", services: 0n, alive: true, lastProbedAt: null }),
    );
    db.peers.upsert(
      basePeer({ host: "4.4.4.4", services: CF, alive: false, lastProbedAt: null }),
    );

    expect(db.peers.listWithServices(CF, 10).map((p) => p.host)).toEqual([
      "2.2.2.2",
      "4.4.4.4",
      "1.1.1.1",
    ]);
    expect(db.peers.listProbeQueue(2).map((p) => p.host)).toEqual([
      "3.3.3.3",
      "4.4.4.4",
    ]);
    db.close();
  });
});
