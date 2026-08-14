import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import {
  setActiveBroadcastBus,
  startUiBroadcast,
} from "../../src/tui/broadcast-actions.ts";
import { createBroadcastStore } from "../../src/tui/broadcast-store.ts";

describe("startUiBroadcast", () => {
  test("marks in-flight before the request so a sync done is not clobbered", () => {
    const bus = createMessageBus();
    const store = createBroadcastStore();
    setActiveBroadcastBus(bus);
    bus.on("broadcast:request", ({ id }) => {
      store.applyDone({ id, ok: false, error: "invalid transaction hex" });
    });

    startUiBroadcast(store, "deadbeef");

    expect(store.get().phase).toBe("error");
    expect(store.get().error).toBe("invalid transaction hex");
  });

  test("ignores a second start while a job is in-flight", () => {
    const bus = createMessageBus();
    const store = createBroadcastStore();
    setActiveBroadcastBus(bus);
    const ids: string[] = [];
    bus.on("broadcast:request", ({ id }) => {
      ids.push(id);
    });

    startUiBroadcast(store, "aa");
    const first = store.get().id;
    startUiBroadcast(store, "bb");

    expect(ids).toHaveLength(1);
    expect(store.get().id).toBe(first);
    expect(store.get().phase).toBe("waiting-peers");
  });

  test("Enter after success returns to idle without a new request", () => {
    const bus = createMessageBus();
    const store = createBroadcastStore();
    setActiveBroadcastBus(bus);
    const ids: string[] = [];
    bus.on("broadcast:request", ({ id }) => {
      ids.push(id);
    });

    store.begin("done-1");
    store.applyDone({ id: "done-1", ok: true, peer: "1.1.1.1:8333" });
    startUiBroadcast(store, "aa");

    expect(store.get().phase).toBe("idle");
    expect(ids).toHaveLength(0);
  });

  test("retries after error", () => {
    const bus = createMessageBus();
    const store = createBroadcastStore();
    setActiveBroadcastBus(bus);
    const ids: string[] = [];
    bus.on("broadcast:request", ({ id }) => {
      ids.push(id);
    });

    store.begin("fail-1");
    store.applyDone({ id: "fail-1", ok: false, error: "no peers" });
    startUiBroadcast(store, "aa");

    expect(ids).toHaveLength(1);
    expect(store.get().phase).toBe("waiting-peers");
    expect(store.get().id).toBe(ids[0]!);
  });
});
