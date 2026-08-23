import type { Database } from "../db/types.ts";
import { usedWatchIndexes } from "../parse/used-indexes.ts";
import {
  firstUnusedExternalAddress,
  preferredWifReceiveAddress,
} from "../wallet/receive-address.ts";
import type { Wallet } from "../wallet/wallet.ts";
import {
  growWatchGapsIfNeeded,
  loadWatchGaps,
  saveWatchGaps,
} from "../wallet/watch-gaps.ts";

export type ReceiveAddressSnapshot = {
  address: string | null;
};

export type ReceiveAddressStore = {
  get(): ReceiveAddressSnapshot;
  refresh(db: Database, wallet: Wallet): void;
  subscribe(listener: () => void): () => void;
};

export const emptyReceiveAddressSnapshot: ReceiveAddressSnapshot = {
  address: null,
};

function snapshotReceiveAddress(
  db: Database,
  wallet: Wallet,
): ReceiveAddressSnapshot {
  wallet.syncFromDb();
  const watch = wallet.snapshot();
  if (watch.kind === "wif") {
    const addr = preferredWifReceiveAddress(watch, db.transactions.list());
    return { address: addr.address };
  }
  if (watch.kind === "address") {
    return { address: watch.addresses[0]?.address ?? null };
  }
  const txs = db.transactions.list().map((t) => ({ tx: t.tx }));
  const used = usedWatchIndexes(txs, watch);
  const addr = firstUnusedExternalAddress(watch, used.external);
  if (addr) return { address: addr.address };

  const grown = growWatchGapsIfNeeded(loadWatchGaps(db), used);
  if (!grown.grew) return { address: null };
  saveWatchGaps(db, grown.gaps);
  const next = wallet.refresh();
  return {
    address:
      firstUnusedExternalAddress(
        next,
        usedWatchIndexes(txs, next).external,
      )?.address ?? null,
  };
}

export function createReceiveAddressStore(): ReceiveAddressStore {
  let snapshot = emptyReceiveAddressSnapshot;
  const listeners = new Set<() => void>();

  function set(next: ReceiveAddressSnapshot): void {
    if (snapshot.address === next.address) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      return snapshot;
    },
    refresh(db, wallet) {
      set(snapshotReceiveAddress(db, wallet));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
