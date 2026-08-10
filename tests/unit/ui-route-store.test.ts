import { describe, expect, test } from "bun:test";
import { createUiRouteStore } from "../../src/tui/ui-route-store.ts";

describe("ui route store", () => {
  test("starts at txs; open/close; idempotent open; notifies once per change", () => {
    const store = createUiRouteStore();
    expect(store.get()).toBe("txs");

    let n = 0;
    const unsub = store.subscribe(() => {
      n++;
    });

    store.open("receive");
    expect(store.get()).toBe("receive");
    expect(n).toBe(1);

    store.open("receive");
    expect(n).toBe(1);

    store.open("send");
    expect(store.get()).toBe("send");
    expect(n).toBe(2);

    store.close();
    expect(store.get()).toBe("txs");
    expect(n).toBe(3);

    store.close();
    expect(n).toBe(3);

    unsub();
    store.open("receive");
    expect(n).toBe(3);
  });
});
