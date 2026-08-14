import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import {
  broadcastJobInFlight,
  inFlightBroadcastEscape,
  previewOwnsBroadcastJob,
  previewShowsBroadcastUi,
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

  test("Enter after success is a no-op (does not return to Broadcast)", () => {
    const bus = createMessageBus();
    const store = createBroadcastStore();
    setActiveBroadcastBus(bus);
    const ids: string[] = [];
    bus.on("broadcast:request", ({ id }) => {
      ids.push(id);
    });

    store.begin("done-1", "aa");
    store.applyDone({ id: "done-1", ok: true, peer: "1.1.1.1:8333" });
    startUiBroadcast(store, "aa");

    expect(store.get().phase).toBe("success");
    expect(store.get().id).toBe("done-1");
    expect(ids).toHaveLength(0);
  });

  test("after success, a different tx may start a new broadcast", () => {
    const bus = createMessageBus();
    const store = createBroadcastStore();
    setActiveBroadcastBus(bus);
    const ids: string[] = [];
    bus.on("broadcast:request", ({ id }) => {
      ids.push(id);
    });

    startUiBroadcast(store, "aa");
    const first = store.get().id!;
    store.applyDone({ id: first, ok: true, peer: "1.1.1.1:8333" });
    startUiBroadcast(store, "bb");

    expect(ids).toHaveLength(2);
    expect(store.get().phase).toBe("waiting-peers");
    expect(store.get().txHex).toBe("bb");
    expect(store.get().id).not.toBe(first);
  });

  test("idle store ignores stale progress and done from a previous job", () => {
    const store = createBroadcastStore();
    store.begin("old-job", "aa");
    store.reset();

    store.applyProgress({
      id: "old-job",
      phase: "attempt",
      attempt: 2,
      peer: "1.1.1.1:8333",
    });
    expect(store.get()).toMatchObject({ id: null, phase: "idle", txHex: null });

    store.applyDone({ id: "old-job", ok: true, peer: "1.1.1.1:8333" });
    expect(store.get()).toMatchObject({ id: null, phase: "idle", txHex: null });
  });

  test("progress and done keep the job's tx hex", () => {
    const store = createBroadcastStore();
    store.begin("j1", "aa");
    store.applyProgress({
      id: "j1",
      phase: "attempt",
      attempt: 1,
      peer: "1.1.1.1:8333",
    });
    expect(store.get().txHex).toBe("aa");
    store.applyDone({ id: "j1", ok: true, peer: "1.1.1.1:8333" });
    expect(store.get().txHex).toBe("aa");
    expect(store.get().phase).toBe("success");
  });

  test("retries after error", () => {
    const bus = createMessageBus();
    const store = createBroadcastStore();
    setActiveBroadcastBus(bus);
    const ids: string[] = [];
    bus.on("broadcast:request", ({ id }) => {
      ids.push(id);
    });

    store.begin("fail-1", "aa");
    store.applyDone({ id: "fail-1", ok: false, error: "no peers" });
    startUiBroadcast(store, "aa");

    expect(ids).toHaveLength(1);
    expect(store.get().phase).toBe("waiting-peers");
    expect(store.get().id).toBe(ids[0]!);
  });
});

describe("inFlightBroadcastEscape", () => {
  test("first Esc on an in-flight job cancels", () => {
    expect(
      inFlightBroadcastEscape("waiting-peers", "job-1", null),
    ).toBe("cancel");
    expect(inFlightBroadcastEscape("attempt", "job-1", null)).toBe("cancel");
  });

  test("second Esc for the same job force-closes", () => {
    expect(
      inFlightBroadcastEscape("attempt", "job-1", "job-1"),
    ).toBe("force-close");
  });

  test("retry after cancel is a new job: first Esc cancels again", () => {
    expect(
      inFlightBroadcastEscape("waiting-peers", "job-2", "job-1"),
    ).toBe("cancel");
  });

  test("ignores idle, success, and error", () => {
    expect(inFlightBroadcastEscape("idle", "job-1", null)).toBe("ignore");
    expect(inFlightBroadcastEscape("success", "job-1", "job-1")).toBe("ignore");
    expect(inFlightBroadcastEscape("error", "job-1", "job-1")).toBe("ignore");
    expect(inFlightBroadcastEscape("attempt", null, null)).toBe("ignore");
  });
});

describe("previewShowsBroadcastUi", () => {
  test("shows progress only for the preview that owns this tx hex", () => {
    expect(previewShowsBroadcastUi("success", "aa", "aa")).toBe(true);
    expect(previewShowsBroadcastUi("waiting-peers", "aa", "aa")).toBe(true);
    expect(previewShowsBroadcastUi("error", "aa", "aa")).toBe(true);
    expect(previewShowsBroadcastUi("success", "aa", "bb")).toBe(false);
    expect(previewShowsBroadcastUi("success", null, "bb")).toBe(false);
    expect(previewShowsBroadcastUi("idle", "aa", "aa")).toBe(false);
  });
});

describe("previewOwnsBroadcastJob", () => {
  test("Esc cancel/force-close only applies to the preview of that hex", () => {
    expect(previewOwnsBroadcastJob("aa", "aa")).toBe(true);
    expect(previewOwnsBroadcastJob("aa", "bb")).toBe(false);
    expect(previewOwnsBroadcastJob(null, "aa")).toBe(false);
    expect(previewOwnsBroadcastJob("aa", undefined)).toBe(false);
  });
});

describe("broadcastJobInFlight", () => {
  test("waiting-peers and attempt stay in-flight so the UI must not reset", () => {
    expect(broadcastJobInFlight("waiting-peers")).toBe(true);
    expect(broadcastJobInFlight("attempt")).toBe(true);
  });

  test("idle, success, and error are not in-flight", () => {
    expect(broadcastJobInFlight("idle")).toBe(false);
    expect(broadcastJobInFlight("success")).toBe(false);
    expect(broadcastJobInFlight("error")).toBe(false);
    expect(broadcastJobInFlight(undefined)).toBe(false);
  });
});
