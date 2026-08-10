import { describe, expect, test } from "bun:test";
import { createHeadersProgressStore } from "../../src/tui/headers-progress-store.ts";

describe("headers progress store", () => {
  test("percent, eta, and ignore non-advancing samples", () => {
    const store = createHeadersProgressStore();
    expect(store.get()).toMatchObject({
      downloaded: 0,
      total: 0,
      at: null,
      etaMs: null,
      percent: 0,
    });

    store.applyEvent({ at: 1000, downloaded: 100, total: 1000, height: 100 });
    expect(store.get().percent).toBe(10);
    expect(store.get().etaMs).toBeNull();

    // same downloaded: updates totals/time but must not create an ETA sample pair
    store.applyEvent({ at: 1500, downloaded: 100, total: 1000, height: 100 });
    expect(store.get().etaMs).toBeNull();
    expect(store.get().at).toBe(1500);

    store.applyEvent({ at: 2000, downloaded: 200, total: 1000, height: 200 });
    // 100 headers / 1000ms → 0.1 h/ms; remaining 800 → 8000ms
    expect(store.get().etaMs).toBe(8000);

    store.applyEvent({ at: 3000, downloaded: 1000, total: 1000, height: 1000 });
    expect(store.get().percent).toBe(100);
    expect(store.get().etaMs).toBe(0);
  });
});
