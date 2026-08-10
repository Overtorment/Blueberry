import { describe, expect, test } from "bun:test";
import { createFilterSessionPool } from "../../src/net/filter-session-pool.ts";
import type { FilterSessionApi } from "../../src/net/filter-sync.ts";
import { stubPlatformNet } from "./stub-platform-net.ts";

const unusedConnect = stubPlatformNet().connect;

function fakeSession(): FilterSessionApi {
  return {
    services: 64n,
    async getCFCheckpt() {
      return [];
    },
    async getCFHeaders() {
      return {
        filterType: 0,
        stopHash: new Uint8Array(32),
        previousFilterHeader: new Uint8Array(32),
        filterHashes: [],
      };
    },
    async getCFilters() {
      return [];
    },
    close() {},
  };
}

describe("filter-session-pool", () => {
  test("reuses an idle session across withSession calls", async () => {
    let opens = 0;
    const pool = createFilterSessionPool({
      connect: unusedConnect,
      max: 2,
      openSession: async () => {
        opens++;
        return { ok: true, value: fakeSession() };
      },
    });
    pool.setPeers([{ host: "1.1.1.1", port: 8333 }]);

    await pool.withSession(async () => "a");
    await pool.withSession(async () => "b");
    expect(opens).toBe(1);
    await pool.closeAll();
  });

  test("cools a failed peer and opens another", async () => {
    let opens = 0;
    const pool = createFilterSessionPool({
      connect: unusedConnect,
      max: 2,
      coolMs: 60_000,
      openSession: async () => {
        opens++;
        return { ok: true, value: fakeSession() };
      },
    });
    pool.setPeers([
      { host: "1.1.1.1", port: 8333 },
      { host: "2.2.2.2", port: 8333 },
    ]);

    await pool
      .withSession(async () => {
        throw new Error("boom");
      })
      .catch(() => {});
    const second = await pool.withSession(async (_s, peer) => peer.host);
    expect(second).toBe("2.2.2.2");
    expect(opens).toBe(2);
    await pool.closeAll();
  });

  test("onOpenCount rises while leased and drops to zero on closeAll", async () => {
    const counts: number[] = [];
    const pool = createFilterSessionPool({
      connect: unusedConnect,
      max: 2,
      openSession: async () => ({ ok: true, value: fakeSession() }),
      onOpenCount: (n) => counts.push(n),
    });
    pool.setPeers([{ host: "1.1.1.1", port: 8333 }]);

    let mid = -1;
    await pool.withSession(async () => {
      mid = counts[counts.length - 1] ?? -1;
      return "ok";
    });
    expect(mid).toBe(1);
    // Idle session retained after lease → still 1
    expect(counts[counts.length - 1]).toBe(1);
    await pool.closeAll();
    expect(counts[counts.length - 1]).toBe(0);
  });

  test("honors coolMs when only one peer is available", async () => {
    let t = 1_000;
    let opens = 0;
    const pool = createFilterSessionPool({
      connect: unusedConnect,
      max: 1,
      coolMs: 5_000,
      now: () => t,
      openSession: async () => {
        opens++;
        return { ok: false, error: "down" };
      },
    });
    pool.setPeers([{ host: "1.1.1.1", port: 8333 }]);

    expect(await pool.withSession(async () => "x")).toBeNull();
    expect(opens).toBe(1);
    expect(await pool.withSession(async () => "x")).toBeNull();
    expect(opens).toBe(1); // still cooling
    expect(pool.coolDelayMs()).toBeGreaterThan(0);

    t += 5_000;
    expect(await pool.withSession(async () => "x")).toBeNull();
    expect(opens).toBe(2);
    await pool.closeAll();
  });
});
