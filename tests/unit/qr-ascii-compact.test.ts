import { describe, expect, test } from "bun:test";
import encodeQR from "qr";
import { qrAsciiLinesCompact } from "../../src/tui/qr-ascii.ts";

describe("qrAsciiLinesCompact", () => {
  test("maps each module pair to ▀/▄/█/space", () => {
    const text = "ur:crypto-psbt/hdnejojkidjyzm";
    const raw = encodeQR(text, "raw", { border: 1 });
    const lines = qrAsciiLinesCompact(text);
    expect(lines.length).toBe(Math.ceil(raw.length / 2));

    for (let y = 0; y < raw.length; y += 2) {
      const line = lines[y / 2]!;
      const top = raw[y]!;
      const bot = raw[y + 1];
      for (let x = 0; x < top.length; x++) {
        const t = !!top[x];
        const b = bot ? !!bot[x] : false;
        const ch = line[x];
        if (t && b) expect(ch).toBe("█");
        else if (t) expect(ch).toBe("▀");
        else if (b) expect(ch).toBe("▄");
        else expect(ch).toBe(" ");
      }
    }
  });
});
