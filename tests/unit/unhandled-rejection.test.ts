import { describe, expect, test } from "bun:test";
import { installFatalUnhandledRejection } from "../../src/boot/unhandled-rejection.ts";

describe("installFatalUnhandledRejection", () => {
  test("logs and exits 1", () => {
    const handlers: Array<(reason: unknown) => void> = [];
    const exits: number[] = [];
    const logged: unknown[] = [];

    installFatalUnhandledRejection({
      onRejection: (reason) => logged.push(reason),
      exit: (code) => exits.push(code),
      process: {
        on(event, handler) {
          expect(event).toBe("unhandledRejection");
          handlers.push(handler as (reason: unknown) => void);
        },
      },
    });

    expect(handlers).toHaveLength(1);
    const reason = new Error("boom");
    handlers[0]!(reason);
    expect(logged).toEqual([reason]);
    expect(exits).toEqual([1]);
  });
});
