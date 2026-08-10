import { describe, expect, test } from "bun:test";
import { utxoListScrollTop } from "../../src/tui/utxo-list-window.ts";

describe("utxoListScrollTop", () => {
  test("keeps focus visible and clamps when the list shrinks", () => {
    expect(utxoListScrollTop(2, 0, 5, 20)).toBe(0);
    expect(utxoListScrollTop(5, 0, 5, 20)).toBe(1);
    expect(utxoListScrollTop(3, 5, 5, 20)).toBe(3);
    expect(utxoListScrollTop(0, 0, 10, 3)).toBe(0);
    expect(utxoListScrollTop(2, 10, 5, 8)).toBe(2);
  });
});
