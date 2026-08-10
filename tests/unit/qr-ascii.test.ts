import { describe, expect, test } from "bun:test";
import encodeQR from "qr";
import { qrAsciiLines } from "../../src/tui/qr-ascii.ts";

describe("qrAsciiLines", () => {
  test("each raw module becomes ██ or two spaces; quiet zone empty", () => {
    const addr = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
    const border = 2;
    const raw = encodeQR(addr, "raw", { border });
    const lines = qrAsciiLines(addr, { border });

    expect(lines.length).toBe(raw.length);
    expect(lines[0]!.length).toBe(raw[0]!.length * 2);
    // Real QR payload — not an empty plate.
    expect(lines.some((l) => l.includes("██"))).toBe(true);

    for (let y = 0; y < raw.length; y++) {
      const row = raw[y]!;
      const line = lines[y]!;
      for (let x = 0; x < row.length; x++) {
        expect(line.slice(x * 2, x * 2 + 2)).toBe(row[x] ? "██" : "  ");
      }
    }

    expect(lines[0]!.trim()).toBe("");
    expect(lines[lines.length - 1]!.trim()).toBe("");
  });
});
