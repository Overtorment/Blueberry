import type { Database } from "../db/types.ts";
import { usedWatchIndexes } from "../parse/used-indexes.ts";
import {
  firstUnusedExternalAddress,
  preferredWifReceiveAddress,
} from "../wallet/receive-address.ts";
import type { Wallet } from "../wallet/wallet.ts";

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
  const used = usedWatchIndexes(
    db.transactions.list().map((t) => ({ tx: t.tx })),
    watch,
  );
  const addr = firstUnusedExternalAddress(watch, used.external);
  return { address: addr?.address ?? null };
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
