import { Panel } from "../chrome.tsx";
import { formatPeerSockets } from "../peer-sockets-store.ts";
import { THEME } from "../theme.ts";
import { usePeerSockets } from "../use-peer-sockets.ts";

export function Peers() {
  const counts = usePeerSockets();
  const open =
    counts.probe + counts.hdr + counts.filt + counts.blk;
  return (
    <Panel
      title="Peers"
      state={open > 0 || counts.known > 0 ? "active" : "idle"}
      accent="cyan"
      paddingY={0}
    >
      <text fg={THEME.fg}>{formatPeerSockets(counts)}</text>
      <text fg={THEME.fgDim}>{counts.known} known</text>
    </Panel>
  );
}
