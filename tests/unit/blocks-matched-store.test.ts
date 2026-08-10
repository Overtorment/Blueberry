import { describe, expect, test } from "bun:test";
import { createBlocksMatchedStore } from "../../src/tui/blocks-matched-store.ts";

describe("blocks matched store", () => {
  test("percent, eta, and ignore non-advancing samples", () => {
    const store = createBlocksMatchedStore();
    expect(store.get()).toMatchObject({
      downloaded: 0,
      matched: 0,
      at: null,
      etaMs: null,
      percent: 0,
    });

    store.applyEvent({ at: 1000, downloaded: 100, matched: 1000 });
    expect(store.get().percent).toBe(10);
    expect(store.get().etaMs).toBeNull();

    // same downloaded: must not create an ETA sample pair
    store.applyEvent({ at: 1500, downloaded: 100, matched: 1000 });
    expect(store.get().etaMs).toBeNull();
    expect(store.get().at).toBe(1500);

    store.applyEvent({ at: 2000, downloaded: 200, matched: 1000 });
    // 100 blocks / 1000ms → 0.1 b/ms; remaining 800 → 8000ms
    expect(store.get().etaMs).toBe(8000);

    store.applyEvent({ at: 3000, downloaded: 1000, matched: 1000 });
    expect(store.get().percent).toBe(100);
    expect(store.get().etaMs).toBe(0);
  });

  test("setMatched updates total without adding download samples", () => {
    const store = createBlocksMatchedStore();
    store.applyEvent({ at: 1000, downloaded: 100, matched: 500 });
    store.setMatched(1000);
    expect(store.get()).toMatchObject({
      downloaded: 100,
      matched: 1000,
      percent: 10,
      etaMs: null,
    });

    store.applyEvent({ at: 2000, downloaded: 200, matched: 1000 });
    expect(store.get().etaMs).toBe(8000);

    store.setMatched(1200);
    // rate still 100/1000ms; remaining 1000 → 10000ms
    expect(store.get().etaMs).toBe(10_000);
    expect(store.get().percent).toBe(16);
  });
});
