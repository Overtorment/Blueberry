import { ActionBar } from "./components/ActionBar.tsx";
import { Balance } from "./components/Balance.tsx";
import { BlueberryArt } from "./components/BlueberryArt.tsx";
import { BlocksDownload } from "./components/BlocksDownload.tsx";
import { ChainTipSync } from "./components/ChainTipSync.tsx";
import { FiltersDownload } from "./components/FiltersDownload.tsx";
import { FiltersMatching } from "./components/FiltersMatching.tsx";
import { Peers } from "./components/Peers.tsx";
import { Transactions } from "./components/Transactions.tsx";
import { WalletModal } from "./components/WalletModal.tsx";
import { THEME } from "./theme.ts";
import { useUiRoute } from "./use-ui-route.ts";
import {
  APP_BALANCE_HEIGHT,
  APP_STRIP_HEIGHT,
} from "./tx-list-capacity.ts";

export function App() {
  const route = useUiRoute();

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      padding={1}
      backgroundColor={THEME.bg}
      position="relative"
    >
      <box
        width="100%"
        height={APP_STRIP_HEIGHT}
        flexDirection="row"
        flexGrow={0}
        gap={1}
      >
        <Peers />
        <ChainTipSync />
        <FiltersDownload />
        <FiltersMatching />
        <BlocksDownload />
      </box>

      <box
        width="100%"
        height={APP_BALANCE_HEIGHT}
        flexDirection="row"
        flexGrow={0}
        gap={1}
      >
        <Balance />
        <BlueberryArt />
      </box>

      <box
        width="100%"
        flexGrow={1}
        position="relative"
        flexDirection="column"
      >
        <Transactions />
        {route === "txs" ? <ActionBar /> : null}
      </box>

      {route === "receive" || route === "send" ? (
        <WalletModal kind={route} />
      ) : null}
    </box>
  );
}
