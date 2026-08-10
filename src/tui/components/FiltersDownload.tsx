import { Panel } from "../chrome.tsx";
import { progressPanelState } from "../panel-state.ts";
import { formatEta, progressBar } from "../progress-format.ts";
import { THEME } from "../theme.ts";
import { useFiltersProgress } from "../use-filters-progress.ts";

export function FiltersDownload() {
  const p = useFiltersProgress();
  const state = progressPanelState(p.percent);
  return (
    <Panel title="Filters DL" state={state} accent="cyan" paddingY={0}>
      <text fg={THEME.fg}>{progressBar(p.percent, 10)}</text>
      <text fg={THEME.fgDim}>
        {p.downloaded}/{p.total}
      </text>
      {p.percent < 100 ? (
        <text fg={THEME.fgDim}>ETA {formatEta(p.etaMs)}</text>
      ) : null}
    </Panel>
  );
}
