import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../../src/bus/message-bus.ts";

describe("MessageBus", () => {
  test("delivers payload to subscribers", () => {
    const bus = createMessageBus();
    const seen: unknown[] = [];
    bus.on("app:started", (p) => seen.push(p));
    bus.emit("app:started", { at: 42 });
    expect(seen).toEqual([{ at: 42 }]);
  });

  test("unsubscribe stops delivery", () => {
    const bus = createMessageBus();
    let count = 0;
    const off = bus.on("module:status", () => {
      count++;
    });
    bus.emit("module:status", {
      module: "x",
      status: "running",
    });
    off();
    bus.emit("module:status", {
      module: "x",
      status: "stopped",
    });
    expect(count).toBe(1);
  });

  test("handler errors do not block other listeners", () => {
    const bus = createMessageBus();
    const seen: string[] = [];
    bus.on("app:started", () => {
      throw new Error("boom");
    });
    bus.on("app:started", (p) => {
      seen.push(String(p.at));
    });
    expect(() => bus.emit("app:started", { at: 1 })).not.toThrow();
    expect(seen).toEqual(["1"]);
  });

  test("delivers peers:updated", () => {
    const bus = createMessageBus();
    const seen: number[] = [];
    bus.on("peers:updated", (p) => seen.push(p.at));
    bus.emit("peers:updated", { at: 99 });
    expect(seen).toEqual([99]);
  });
});
