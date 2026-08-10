import { describe, expect, test } from "bun:test";
import { formatBlockTimeLabel } from "../../src/parse/format-block-time.ts";

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const MONTH_S = 30 * 24 * 3600;

describe("formatBlockTimeLabel", () => {
  test("relative buckets and month boundary", () => {
    expect(formatBlockTimeLabel(NOW_S, NOW_MS)).toBe("just now".padEnd(16));
    expect(formatBlockTimeLabel(NOW_S - 59, NOW_MS)).toBe("just now".padEnd(16));
    expect(formatBlockTimeLabel(NOW_S - 60, NOW_MS)).toBe("1m ago".padEnd(16));
    expect(formatBlockTimeLabel(NOW_S - 3600, NOW_MS)).toBe("1h ago".padEnd(16));
    expect(formatBlockTimeLabel(NOW_S - 24 * 3600, NOW_MS)).toBe(
      "1d ago".padEnd(16),
    );
    expect(formatBlockTimeLabel(NOW_S - MONTH_S, NOW_MS)).toBe(
      "30d ago".padEnd(16),
    );
  });

  test("absolute past one month", () => {
    const prev = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      // 2023-09-15 12:00:00 UTC — older than one month before NOW_MS
      const older = Date.UTC(2023, 8, 15, 12, 0, 0) / 1000;
      expect(formatBlockTimeLabel(older, NOW_MS)).toBe("2023-09-15 12:00");
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  test("future clamps to just now", () => {
    expect(formatBlockTimeLabel(NOW_S + 3600, NOW_MS)).toBe(
      "just now".padEnd(16),
    );
  });
});
