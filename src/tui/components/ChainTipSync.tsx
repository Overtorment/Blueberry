import { Panel } from "../chrome.tsx";
import { progressPanelState } from "../panel-state.ts";
import { formatEta, progressBar } from "../progress-format.ts";
import { THEME } from "../theme.ts";
import { useHeadersProgress } from "../use-headers-progress.ts";

export function ChainTipSync() {
  const p = useHeadersProgress();
  const state = progressPanelState(p.percent);
  return (
    <Panel title="Chain tip" state={state} accent="magenta" paddingY={0}>
      <text fg={THEME.fg}>{progressBar(p.percent, 10)}</text>
      <text fg={THEME.fgDim}>
        {p.downloaded}/{p.total}
      </text>
      <text fg={THEME.fgDim}>{p.height} tip</text>
      {p.percent < 100 ? (
        <text fg={THEME.fgDim}>ETA {formatEta(p.etaMs)}</text>
      ) : null}
    </Panel>
  );
}
