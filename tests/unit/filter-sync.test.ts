import { describe, expect, test } from "bun:test";
import { openFilterSession } from "../../src/net/filter-sync.ts";
import { stubDuplex } from "./stub-platform-net.ts";

describe("openFilterSession", () => {
  test("maps connect failure to ok:false", async () => {
    const result = await openFilterSession("1.2.3.4", 8333, {
      connectTimeoutMs: 100,
      syncTimeoutMs: 100,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
  });

  test("uses injected runSession", async () => {
    const stop = new Uint8Array(32);
    const result = await openFilterSession("1.2.3.4", 8333, {
      connect: async () => stubDuplex(),
      runSession: async () => ({
        services: 64n,
        async getCFCheckpt() {
          return [new Uint8Array(32)];
        },
        async getCFHeaders() {
          return {
            filterType: 0,
            stopHash: stop,
            previousFilterHeader: new Uint8Array(32),
            filterHashes: [new Uint8Array(32)],
          };
        },
        async getCFilters() {
          return [{ blockHash: stop, filterBytes: new Uint8Array([1]) }];
        },
        close() {},
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.services).toBe(64n);
      expect(await result.value.getCFCheckpt(stop)).toHaveLength(1);
    }
  });
});
