import { describe, expect, test } from "bun:test";
import { createFiltersProgressStore } from "../../src/tui/filters-progress-store.ts";

describe("filters progress store", () => {
  test("percent, eta, and ignore non-advancing samples", () => {
    const store = createFiltersProgressStore();
    expect(store.get()).toMatchObject({
      downloaded: 0,
      total: 0,
      at: null,
      etaMs: null,
      percent: 0,
    });

    store.applyEvent({ at: 1000, downloaded: 100, total: 1000 });
    expect(store.get().percent).toBe(10);
    expect(store.get().etaMs).toBeNull();

    // same downloaded: updates totals/time but must not create an ETA sample pair
    store.applyEvent({ at: 1500, downloaded: 100, total: 1000 });
    expect(store.get().etaMs).toBeNull();
    expect(store.get().at).toBe(1500);

    store.applyEvent({ at: 2000, downloaded: 200, total: 1000 });
    // 100 filters / 1000ms → 0.1 f/ms; remaining 800 → 8000ms
    expect(store.get().etaMs).toBe(8000);

    store.applyEvent({ at: 3000, downloaded: 1000, total: 1000 });
    expect(store.get().percent).toBe(100);
    expect(store.get().etaMs).toBe(0);
  });

  test("ETA ignores completion→idle dead time when work resumes", () => {
    const store = createFiltersProgressStore();
    store.applyEvent({ at: 1000, downloaded: 500, total: 1000 });
    store.applyEvent({ at: 2000, downloaded: 1000, total: 1000 });
    expect(store.get().etaMs).toBe(0);

    // More filters appear after a long idle; percent drops below 100.
    store.applyEvent({ at: 1_000_000, downloaded: 1000, total: 5000 });
    expect(store.get().percent).toBe(20);
    expect(store.get().etaMs).toBeNull();

    // Fresh rate from resume only — not from the ancient completion sample.
    store.applyEvent({ at: 1_001_000, downloaded: 1100, total: 5000 });
    expect(store.get().etaMs).toBe(39_000);
  });
});
