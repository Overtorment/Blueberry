import { describe, expect, test } from "bun:test";
import { MSG_BLOCK } from "../../src/net/block-sync.ts";
import {
  fetchHeadersBatch,
  headerMessageSuggestsNewTip,
} from "../../src/net/header-sync.ts";
import { stubDuplex } from "./stub-platform-net.ts";

describe("fetchHeadersBatch", () => {
  test("maps connect failure to ok:false", async () => {
    const result = await fetchHeadersBatch("1.2.3.4", 8333, {
      connectTimeoutMs: 500,
      locatorHashes: [new Uint8Array(32)],
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  test("connectTimeout aborts slow connect and closes duplex", async () => {
    let closed = false;
    const result = await fetchHeadersBatch("1.2.3.4", 8333, {
      connectTimeoutMs: 20,
      headersTimeoutMs: 5_000,
      locatorHashes: [new Uint8Array(32)],
      connect: async () => {
        await new Promise((r) => setTimeout(r, 200));
        const d = stubDuplex();
        return {
          ...d,
          close: async () => {
            closed = true;
            await d.close();
          },
        };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out|aborted/);
    await new Promise((r) => setTimeout(r, 250));
    expect(closed).toBe(true);
  });

  test("headersTimeout applies after connect for injected requestHeaders", async () => {
    const started = Date.now();
    const result = await fetchHeadersBatch("1.2.3.4", 8333, {
      connectTimeoutMs: 5_000,
      headersTimeoutMs: 30,
      locatorHashes: [new Uint8Array(32)],
      connect: async () => stubDuplex(),
      requestHeaders: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { startHeight: 1, headers: [] };
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out|aborted/);
    expect(Date.now() - started).toBeLessThan(150);
  });

  test("forwards locator and stopHash into requestHeaders", async () => {
    const locator = [new Uint8Array(32).fill(7)];
    const stop = new Uint8Array(32).fill(9);
    let seen: {
      port: number;
      locatorHashes: Uint8Array[];
      stopHash: Uint8Array;
    } | null = null;

    const result = await fetchHeadersBatch("1.2.3.4", 8333, {
      connectTimeoutMs: 500,
      headersTimeoutMs: 500,
      locatorHashes: locator,
      stopHash: stop,
      connect: async () => stubDuplex(),
      requestHeaders: async (_duplex, port, locatorHashes, stopHash) => {
        seen = { port, locatorHashes, stopHash };
        return { startHeight: 1, headers: [] };
      },
    });

    expect(result.ok).toBe(true);
    expect(seen).not.toBeNull();
    expect(seen!.port).toBe(8333);
    expect(seen!.locatorHashes).toBe(locator);
    expect(seen!.stopHash).toBe(stop);
  });
});

describe("headerMessageSuggestsNewTip", () => {
  test("inv block and headers hint a new tip", () => {
    expect(
      headerMessageSuggestsNewTip({
        command: "inv",
        payload: { inventory: [{ type: MSG_BLOCK, hash: new Uint8Array(32) }] },
      }),
    ).toBe(true);
    expect(
      headerMessageSuggestsNewTip({
        command: "headers",
        payload: {
          headers: [
            {
              version: 1,
              previousBlockHash: new Uint8Array(32),
              merkleRoot: new Uint8Array(32),
              timestamp: 0,
              bits: 0,
              nonce: 0,
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      headerMessageSuggestsNewTip({
        command: "ping",
        nonce: new Uint8Array(8),
      }),
    ).toBe(false);
    expect(
      headerMessageSuggestsNewTip({
        command: "inv",
        payload: { inventory: [{ type: 1, hash: new Uint8Array(32) }] },
      }),
    ).toBe(false);
  });
});
