import { describe, expect, test } from "bun:test";
import * as filterSync from "../../src/net/filter-sync.ts";
import { openFilterSession } from "../../src/net/filter-sync.ts";
import { stubDuplex } from "./stub-platform-net.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

  test("refreshes the cfilter timeout whenever activity arrives", async () => {
    const createInactivityTimeout = (
      filterSync as unknown as {
        createInactivityTimeout?: (
          controller: AbortController,
          ms: number,
          label: string,
        ) => { refresh(): void; clear(): void };
      }
    ).createInactivityTimeout;
    expect(typeof createInactivityTimeout).toBe("function");
    if (!createInactivityTimeout) return;

    const controller = new AbortController();
    const timeout = createInactivityTimeout(controller, 100, "cfilters");
    await sleep(60);
    timeout.refresh();
    await sleep(60);
    expect(controller.signal.aborted).toBe(false);
    await sleep(60);
    expect(controller.signal.aborted).toBe(true);
    expect((controller.signal.reason as Error).message).toBe(
      "cfilters inactive for 100ms",
    );
    timeout.clear();
  });

  test("allows a request to outlive its timeout while activity continues", async () => {
    type RunWithInactivityTimeout = <T>(
      ms: number,
      label: string,
      work: (
        controller: AbortController,
        activity: () => void,
      ) => Promise<T>,
    ) => Promise<T>;
    const runWithInactivityTimeout = (
      filterSync as unknown as {
        runWithInactivityTimeout?: RunWithInactivityTimeout;
      }
    ).runWithInactivityTimeout;
    expect(typeof runWithInactivityTimeout).toBe("function");
    if (!runWithInactivityTimeout) return;

    const result = await runWithInactivityTimeout(
      100,
      "cfilters",
      async (_controller, activity) => {
        await sleep(60);
        activity();
        await sleep(60);
        activity();
        return "complete";
      },
    );
    expect(result).toBe("complete");
  });
});
