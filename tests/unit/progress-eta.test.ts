import { describe, expect, test } from "bun:test";
import {
  estimateEtaMs,
  nextProgressSamples,
} from "../../src/tui/progress-eta.ts";

describe("estimateEtaMs", () => {
  test("rejects insufficient or flat samples", () => {
    expect(estimateEtaMs([{ at: 1, downloaded: 5 }], 10)).toBeNull();
    expect(
      estimateEtaMs(
        [
          { at: 1, downloaded: 5 },
          { at: 2, downloaded: 5 },
        ],
        10,
      ),
    ).toBeNull();
  });

  test("computes remaining time from advancing samples", () => {
    expect(
      estimateEtaMs(
        [
          { at: 1000, downloaded: 100 },
          { at: 2000, downloaded: 200 },
        ],
        1000,
      ),
    ).toBe(8000);
  });
});

describe("nextProgressSamples", () => {
  test("resets when downloaded goes backwards", () => {
    expect(
      nextProgressSamples(
        [
          { at: 1000, downloaded: 100 },
          { at: 2000, downloaded: 200 },
        ],
        { downloaded: 200, total: 1000 },
        { at: 9000, downloaded: 50, total: 1000 },
      ),
    ).toEqual([{ at: 9000, downloaded: 50 }]);
  });
});
