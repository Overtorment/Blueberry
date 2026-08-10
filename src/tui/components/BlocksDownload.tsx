import { Panel } from "../chrome.tsx";
import { progressPanelState } from "../panel-state.ts";
import { formatEta, progressBar } from "../progress-format.ts";
import { THEME } from "../theme.ts";
import { useBlocksProgress } from "../use-blocks-matched.ts";

export function BlocksDownload() {
  const p = useBlocksProgress();
  const state = progressPanelState(p.percent);
  return (
    <Panel title="Blocks DL" state={state} accent="cyan" paddingY={0}>
      <text fg={THEME.fg}>{progressBar(p.percent, 10)}</text>
      <text fg={THEME.fgDim}>
        {p.downloaded}/{p.matched}
      </text>
      {p.percent < 100 ? (
        <text fg={THEME.fgDim}>ETA {formatEta(p.etaMs)}</text>
      ) : null}
    </Panel>
  );
}
