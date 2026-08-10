import { Panel } from "../chrome.tsx";
import { useWalletTxs } from "../use-wallet-txs.ts";
import { BtcAmount } from "./BtcAmount.tsx";

export function Balance() {
  const w = useWalletTxs();
  const active = w.balanceSats !== 0n || w.txs.length > 0;
  return (
    <Panel
      title="Balance"
      state={active ? "active" : "idle"}
      accent="magenta"
      flexGrow={0}
      flexShrink={0}
      width="auto"
    >
      <text>
        <BtcAmount sats={w.balanceSats} />
      </text>
    </Panel>
  );
}
