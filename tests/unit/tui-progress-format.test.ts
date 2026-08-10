import { describe, expect, test } from "bun:test";
import { formatEta, progressBar } from "../../src/tui/progress-format.ts";

describe("formatEta", () => {
  test("null unknown, non-positive done, seconds and minutes", () => {
    expect(formatEta(null)).toBe("—");
    expect(formatEta(0)).toBe("done");
    expect(formatEta(-1)).toBe("done");
    expect(formatEta(1500)).toBe("2s");
    expect(formatEta(65_000)).toBe("1m 5s");
  });
});

describe("progressBar", () => {
  test("empty mid full", () => {
    expect(progressBar(0, 10)).toBe("[░░░░░░░░░░] 0%");
    expect(progressBar(50, 10)).toBe("[█████░░░░░] 50%");
    expect(progressBar(100, 10)).toBe("[██████████] 100%");
  });

  test("clamps out-of-range percent", () => {
    expect(progressBar(-10, 10)).toBe("[░░░░░░░░░░] 0%");
    expect(progressBar(200, 10)).toBe("[██████████] 100%");
  });
});
