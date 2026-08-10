import { Panel } from "../chrome.tsx";
import { progressPanelState } from "../panel-state.ts";
import { formatEta, progressBar } from "../progress-format.ts";
import { THEME } from "../theme.ts";
import { useMatchingProgress } from "../use-matching-progress.ts";

export function FiltersMatching() {
  const p = useMatchingProgress();
  const state = progressPanelState(p.percent);
  const eta =
    p.etaMs !== null
      ? formatEta(p.etaMs)
      : p.total > 0 && p.scanned < p.total
        ? "…"
        : formatEta(null);
  return (
    <Panel title="Filters match" state={state} accent="magenta" paddingY={0}>
      <text fg={THEME.fg}>{progressBar(p.percent, 10)}</text>
      <text fg={THEME.fgDim}>
        {p.scanned}/{p.total}
      </text>
      {p.percent < 100 ? (
        <text fg={THEME.fgDim}>ETA {eta}</text>
      ) : null}
    </Panel>
  );
}
