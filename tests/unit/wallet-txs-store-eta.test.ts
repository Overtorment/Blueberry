import { describe, expect, test } from "bun:test";
import {
  createWalletTxsStore,
  emptyWalletTxsSnapshot,
  type WalletTxsSnapshot,
} from "../../src/tui/wallet-txs-store.ts";

function snap(
  partial: Pick<WalletTxsSnapshot, "at" | "blocksParsed" | "blocksTotal">,
): WalletTxsSnapshot {
  return {
    ...emptyWalletTxsSnapshot,
    ...partial,
    etaMs: null,
  };
}

describe("wallet txs store active parse ETA", () => {
  test("estimates only while parsing is active", () => {
    const store = createWalletTxsStore();
    store.apply(snap({ at: 1000, blocksParsed: 100, blocksTotal: 1000 }));
    store.apply(snap({ at: 2000, blocksParsed: 200, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();

    store.setParsingActive(true);
    store.apply(snap({ at: 3000, blocksParsed: 300, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();
    store.apply(snap({ at: 4000, blocksParsed: 400, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBe(6000);
  });

  test("pause clears ETA; resume excludes paused time", () => {
    const store = createWalletTxsStore();
    store.setParsingActive(true);
    store.apply(snap({ at: 1000, blocksParsed: 100, blocksTotal: 1000 }));
    store.apply(snap({ at: 2000, blocksParsed: 200, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBe(8000);

    store.setParsingActive(false);
    expect(store.get().etaMs).toBeNull();
    store.apply(snap({ at: 1_000_000, blocksParsed: 300, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();

    store.setParsingActive(true);
    store.apply(snap({ at: 1_001_000, blocksParsed: 400, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();
    store.apply(snap({ at: 1_002_000, blocksParsed: 500, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBe(5000);
  });
});
