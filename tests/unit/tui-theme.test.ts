import { describe, expect, test } from "bun:test";
import {
  THEME,
  borderColorFor,
  titleColorFor,
} from "../../src/tui/theme.ts";

describe("tui theme", () => {
  test("tokens are ansi256 indexed (screen-safe), not free rgb", () => {
    for (const [name, color] of Object.entries(THEME)) {
      expect(color.intent, name).toBe("indexed");
      expect(color.slot, name).toBeGreaterThanOrEqual(16); // skip 0-15 ambiguity
      expect(color.slot, name).toBeLessThanOrEqual(255);
    }
  });

  test("state picks border/title roles", () => {
    // idle: dim chrome
    expect(borderColorFor("idle", "cyan")).toBe(THEME.borderIdle);
    expect(titleColorFor("idle", "cyan")).toBe(THEME.fgDim);
    // active: accent (border and title agree)
    expect(borderColorFor("active", "magenta")).toBe(THEME.accentMagenta);
    expect(titleColorFor("active", "magenta")).toBe(THEME.accentMagenta);
    expect(borderColorFor("active", "cyan")).toBe(THEME.accentCyan);
    // done: green, accent ignored
    expect(borderColorFor("done", "cyan")).toBe(THEME.done);
    expect(titleColorFor("done", "magenta")).toBe(THEME.done);
  });
});
