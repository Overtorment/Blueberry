export function formatEta(etaMs: number | null): string {
  if (etaMs === null) return "—";
  if (etaMs <= 0) return "done";
  const s = Math.round(etaMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

export function formatParseProgress(
  parsed: number,
  total: number,
  etaMs: number | null,
): string {
  const progress = `${parsed}/${total} blocks parsed`;
  return etaMs === null ? progress : `${progress} (ETA ${formatEta(etaMs)})`;
}

export function progressBar(percent: number, width = 20): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const cells = Array.from({ length: width }, (_, i) =>
    i < filled ? "█" : "░",
  );
  return `[${cells.join("")}] ${clamped}%`;
}
