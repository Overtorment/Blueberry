import { describe, expect, test } from "bun:test";
import { progressPanelState } from "../../src/tui/panel-state.ts";

describe("progressPanelState", () => {
  test("boundaries", () => {
    expect(progressPanelState(0)).toBe("idle");
    expect(progressPanelState(0.1)).toBe("active");
    expect(progressPanelState(99.9)).toBe("active");
    expect(progressPanelState(100)).toBe("done");
  });

  test("clamps odd inputs into idle/done", () => {
    expect(progressPanelState(-5)).toBe("idle");
    expect(progressPanelState(150)).toBe("done");
  });
});
