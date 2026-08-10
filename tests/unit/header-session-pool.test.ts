import { describe, expect, test } from "bun:test";
import { createHeaderSessionPool } from "../../src/net/header-sync.ts";

function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("timeout waiting for condition"));
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("HeaderSessionPool", () => {
  test("reuses a session across successful batches (one open)", async () => {
    let opens = 0;
    let requests = 0;

    const pool = createHeaderSessionPool({
      openSession: async () => {
        opens++;
        return {
          startHeight: 700_000,
          requestHeaders: async () => {
            requests++;
            return { startHeight: 700_000, headers: [] };
          },
          close: async () => {},
        };
      },
    });

    const a = await pool.fetchBatch("1.1.1.1", 8333, {
      locatorHashes: [new Uint8Array(32)],
    });
    const b = await pool.fetchBatch("1.1.1.1", 8333, {
      locatorHashes: [new Uint8Array(32)],
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(opens).toBe(1);
    expect(requests).toBe(2);
    expect(pool.has("1.1.1.1", 8333)).toBe(true);

    await pool.closeAll();
    expect(pool.has("1.1.1.1", 8333)).toBe(false);
  });

  test("reports busy without dropping the session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pool = createHeaderSessionPool({
      openSession: async () => ({
        startHeight: 1,
        requestHeaders: async () => {
          await gate;
          return { startHeight: 1, headers: [] };
        },
        close: async () => {},
      }),
    });

    const firstP = pool.fetchBatch("3.3.3.3", 8333, {
      locatorHashes: [new Uint8Array(32)],
    });
    await waitFor(() => pool.isBusy("3.3.3.3", 8333));
    const busy = await pool.fetchBatch("3.3.3.3", 8333, {
      locatorHashes: [new Uint8Array(32)],
    });
    expect(busy).toEqual({ ok: false, error: "session busy" });
    expect(pool.has("3.3.3.3", 8333)).toBe(true);
    release();
    expect((await firstP).ok).toBe(true);
    expect(pool.isBusy("3.3.3.3", 8333)).toBe(false);
    await pool.closeAll();
  });

  test("drops session after a failed getheaders", async () => {
    let opens = 0;
    const pool = createHeaderSessionPool({
      openSession: async () => {
        opens++;
        return {
          startHeight: 1,
          requestHeaders: async () => {
            throw new Error("peer reset");
          },
          close: async () => {},
        };
      },
    });

    const first = await pool.fetchBatch("2.2.2.2", 8333, {
      locatorHashes: [new Uint8Array(32)],
    });
    expect(first.ok).toBe(false);
    expect(pool.has("2.2.2.2", 8333)).toBe(false);

    await pool.fetchBatch("2.2.2.2", 8333, {
      locatorHashes: [new Uint8Array(32)],
    });
    expect(opens).toBe(2);
    await pool.closeAll();
  });
});
