import { describe, expect, test } from "bun:test";
import { txListCapacity } from "../../src/tui/tx-list-capacity.ts";

describe("txListCapacity", () => {
  test("fits recent txs into remaining panel rows", () => {
    // 24-row terminal: 2 pad + 2 gaps + 6 strip + 5 balance + 4 panel = 19 → 5 content
    expect(txListCapacity(24, 0)).toBe(5);
    // progress line reserves 1
    expect(txListCapacity(24, 1)).toBe(4);
    // two reserved lines → one fewer than reservedLines=1
    expect(txListCapacity(24, 2)).toBe(txListCapacity(24, 1) - 1);
  });

  test("never returns negative", () => {
    expect(txListCapacity(10, 0)).toBe(0);
    expect(txListCapacity(20, 5)).toBe(0);
  });
});
