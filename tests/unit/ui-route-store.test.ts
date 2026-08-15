import { describe, expect, test } from "bun:test";
import { createUiRouteStore } from "../../src/tui/ui-route-store.ts";
import { openTempFileLog } from "./file-log-harness.ts";

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

  test("logs route changes once per change", () => {
    const file = openTempFileLog();
    const store = createUiRouteStore();
    store.open("receive");
    store.open("receive");
    store.open("send");
    store.close();
    store.close();
    const text = file.read();
    file.close();
    expect(text).toContain("[tui] route receive");
    expect(text).toContain("[tui] route send");
    expect(text).toContain("[tui] route txs");
    expect(text.split("[tui] route receive").length - 1).toBe(1);
    expect(text.split("[tui] route txs").length - 1).toBe(1);
  });
});
