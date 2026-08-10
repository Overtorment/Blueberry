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

describe("wallet txs store ETA", () => {
  test("empty snapshot has null eta; <2 advancing samples stay null", () => {
    expect(emptyWalletTxsSnapshot.etaMs).toBeNull();

    const store = createWalletTxsStore();
    expect(store.get().etaMs).toBeNull();

    store.apply(snap({ at: 1000, blocksParsed: 100, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();

    // same parsed count: update time but no advancing sample pair
    store.apply(snap({ at: 1500, blocksParsed: 100, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();
    expect(store.get().at).toBe(1500);
  });

  test("advancing parse with backlog yields ETA; done clears eta", () => {
    const store = createWalletTxsStore();
    store.apply(snap({ at: 1000, blocksParsed: 100, blocksTotal: 1000 }));
    store.apply(snap({ at: 2000, blocksParsed: 200, blocksTotal: 1000 }));
    // 100 blocks / 1000ms → 0.1 b/ms; remaining 800 → 8000ms
    expect(store.get().etaMs).toBe(8000);

    store.apply(snap({ at: 3000, blocksParsed: 1000, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();
  });

  test("ETA ignores completion→idle dead time when work resumes", () => {
    const store = createWalletTxsStore();
    store.apply(snap({ at: 1000, blocksParsed: 500, blocksTotal: 1000 }));
    store.apply(snap({ at: 2000, blocksParsed: 1000, blocksTotal: 1000 }));
    expect(store.get().etaMs).toBeNull();

    // More blocks appear after a long idle; backlog returns.
    store.apply(snap({ at: 1_000_000, blocksParsed: 1000, blocksTotal: 5000 }));
    expect(store.get().etaMs).toBeNull();

    // Fresh rate from resume only — not from the ancient completion sample.
    store.apply(snap({ at: 1_001_000, blocksParsed: 1100, blocksTotal: 5000 }));
    expect(store.get().etaMs).toBe(39_000);
  });
});
