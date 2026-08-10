import { describe, expect, test } from "bun:test";
import { withTorDialRetries } from "../../src/modules/broadcast/tor-dial-policy.ts";

describe("withTorDialRetries", () => {
  test("succeeds on a later cycle after disposing the failed dialer", async () => {
    const disposed: number[] = [];
    let creates = 0;
    const result = await withTorDialRetries(
      () => {
        const id = ++creates;
        return {
          dial: async () => {
            if (id < 2) throw new Error("tor extend circuit: timed out");
            return { id } as never;
          },
          dispose: async () => {
            disposed.push(id);
          },
        };
      },
      async (dial, signal) => dial("1.2.3.4", 8333, signal),
      { attempts: 3, backoffMs: 0, signal: AbortSignal.timeout(5_000) },
    );
    expect((result as { id: number }).id).toBe(2);
    expect(creates).toBe(2);
    expect(disposed).toEqual([1, 2]);
  });

  test("stops on abort without further cycles", async () => {
    const abort = new AbortController();
    let creates = 0;
    const pending = withTorDialRetries(
      () => {
        creates++;
        return {
          dial: async () => {
            abort.abort(new Error("cancelled"));
            throw new Error("tor bootstrap: fail");
          },
          dispose: async () => {},
        };
      },
      async (dial, signal) => dial("1.2.3.4", 8333, signal),
      { attempts: 5, backoffMs: 0, signal: abort.signal },
    );
    await expect(pending).rejects.toThrow(/cancelled|abort|fail/i);
    expect(creates).toBe(1);
  });
});
