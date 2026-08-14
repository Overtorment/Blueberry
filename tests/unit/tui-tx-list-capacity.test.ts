import { describe, expect, test } from "bun:test";
import { txListCapacity } from "../../src/tui/tx-list-capacity.ts";

describe("txListCapacity", () => {
  test("fits recent txs into remaining panel rows", () => {
    // 24-row terminal: 2 pad + 2 gaps + 6 strip + 5 balance + 4 panel + 5 action bar
    // → 0 content (ActionBar overlays the txs panel; do not paint under it).
    expect(txListCapacity(24, 0)).toBe(0);
    expect(txListCapacity(24, 1)).toBe(0);
    // 30-row: 6 extra rows above the 24-row floor → 6 content (5 with parse row).
    expect(txListCapacity(30, 0)).toBe(6);
    expect(txListCapacity(30, 1)).toBe(5);
  });

  test("never returns negative", () => {
    expect(txListCapacity(10, 0)).toBe(0);
    expect(txListCapacity(20, 5)).toBe(0);
  });
});
