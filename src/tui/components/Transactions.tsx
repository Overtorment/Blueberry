import { useTerminalDimensions } from "@opentui/react";
import { Panel } from "../chrome.tsx";
import { formatParseProgress } from "../progress-format.ts";
import { THEME } from "../theme.ts";
import { txListCapacity } from "../tx-list-capacity.ts";
import { useModuleStatus } from "../use-module-status.ts";
import { useWalletTxs } from "../use-wallet-txs.ts";
import { BtcAmount } from "./BtcAmount.tsx";

export function Transactions() {
  const status = useModuleStatus("parse-blocks");
  const w = useWalletTxs();
  const { height: termHeight } = useTerminalDimensions();
  const hasParseBacklog = w.blocksTotal > w.blocksParsed;
  const active =
    (status !== "idle" && status !== "…") ||
    w.txs.length > 0 ||
    hasParseBacklog;
  const reservedLines = hasParseBacklog ? 1 : 0;
  const maxTxRows = txListCapacity(termHeight, reservedLines);
  const visibleTxs = w.txs.slice(0, maxTxRows);

  return (
    <Panel
      title="Transactions"
      state={active ? "active" : "idle"}
      accent="cyan"
      flexGrow={1}
    >
      <box width="100%" height="100%" flexDirection="column" overflow="hidden">
        {hasParseBacklog ? (
          <text fg={THEME.fgDim}>
            {formatParseProgress(
              w.blocksParsed,
              w.blocksTotal,
              w.etaMs,
            )}
          </text>
        ) : null}
        {visibleTxs.length > 0
          ? visibleTxs.map((tx) => (
              <text key={tx.txid}>
                <span fg={THEME.fg}>
                  {`${tx.timeLabel}  ${tx.shortTxid}  `}
                </span>
                <BtcAmount sats={BigInt(tx.netDeltaSats)} plus />
              </text>
            ))
          : !hasParseBacklog
            ? <text fg={THEME.fgDim}>{status}</text>
            : null}
      </box>
    </Panel>
  );
}
