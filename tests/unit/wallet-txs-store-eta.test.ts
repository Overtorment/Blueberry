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

describe("wallet txs store parse progress", () => {
  test("never estimates parse ETA (backlog uses x/y only)", () => {
    expect(emptyWalletTxsSnapshot.etaMs).toBeNull();
    const store = createWalletTxsStore();
    store.apply(snap({ at: 1000, blocksParsed: 100, blocksTotal: 1000 }));
    store.apply(snap({ at: 2000, blocksParsed: 200, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();
    expect(store.get().blocksParsed).toBe(200);
    expect(store.get().blocksTotal).toBe(1000);
  });
});
