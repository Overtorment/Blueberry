import { describe, expect, test } from "bun:test";
import { shouldHardQuit } from "../../src/tui/quit-key.ts";

describe("shouldHardQuit", () => {
  test("q/Q quit only when no text editor is focused", () => {
    expect(shouldHardQuit({ name: "q" }, null)).toBe(true);
    expect(shouldHardQuit({ name: "Q" }, null)).toBe(true);
    expect(shouldHardQuit({ name: "q" }, {})).toBe(false);
    expect(shouldHardQuit({ name: "a" }, null)).toBe(false);
  });
});
