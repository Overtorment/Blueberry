import encodeQR from "qr";

/**
 * Scannable QR for OpenTUI from the raw module matrix.
 * Full `█` / space only (half-blocks ▀/▄ can confuse phone cameras on odd rows).
 * Render on a light background with dark foreground.
 */
export function qrAsciiLines(
  text: string,
  opts?: { border?: number },
): string[] {
  const matrix = encodeQR(text, "raw", { border: opts?.border ?? 2 });
  // Two cells per module ≈ square modules in a typical terminal cell grid.
  return matrix.map((row) =>
    row.map((on) => (on ? "██" : "  ")).join(""),
  );
}

/**
 * Compact QR: 1 cell wide × 2 modules tall (▀/▄/█).
 * ~¼ the area of {@link qrAsciiLines} — for dense payloads (UR fragments).
 */
export function qrAsciiLinesCompact(
  text: string,
  opts?: { border?: number },
): string[] {
  const matrix = encodeQR(text, "raw", { border: opts?.border ?? 1 });
  const h = matrix.length;
  const w = matrix[0]?.length ?? 0;
  const lines: string[] = [];
  for (let y = 0; y < h; y += 2) {
    let line = "";
    const top = matrix[y]!;
    const bot = y + 1 < h ? matrix[y + 1]! : null;
    for (let x = 0; x < w; x++) {
      const t = !!top[x];
      const b = bot ? !!bot[x] : false;
      if (t && b) line += "█";
      else if (t) line += "▀";
      else if (b) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines;
}

/** Cell size of a compact QR for `text` (before rendering). */
export function qrCompactSize(
  text: string,
  opts?: { border?: number },
): { width: number; height: number } {
  const matrix = encodeQR(text, "raw", { border: opts?.border ?? 1 });
  const modules = matrix.length;
  return {
    width: matrix[0]?.length ?? 0,
    height: Math.ceil(modules / 2),
  };
}

/**
 * Full-module QR when it fits `maxWidth` × `maxHeight`; compact otherwise.
 * Receive uses this so a 24-row terminal still shows a scannable code + address.
 */
export function qrAsciiLinesFitting(
  text: string,
  maxWidth: number,
  maxHeight: number,
): string[] {
  const full = qrAsciiLines(text);
  const fullW = full[0]?.length ?? 0;
  if (full.length <= maxHeight && fullW <= maxWidth) return full;
  return qrAsciiLinesCompact(text);
}
