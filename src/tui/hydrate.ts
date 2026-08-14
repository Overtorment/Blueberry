import type { Database } from "../db/types.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { BlocksMatchedStore } from "./blocks-matched-store.ts";
import type { FiltersProgressStore } from "./filters-progress-store.ts";
import type { HeadersProgressStore } from "./headers-progress-store.ts";
import type { MatchingProgressStore } from "./matching-progress-store.ts";
import type { PeerSocketsStore } from "./peer-sockets-store.ts";
import type { ReceiveAddressStore } from "./receive-address-store.ts";
import type { WalletTxsSnapshot, WalletTxsStore } from "./wallet-txs-store.ts";
import { snapshotFromDb } from "./wallet-txs-store.ts";

export type HydrateStores = {
  peerSocketsStore: PeerSocketsStore;
  headersProgressStore: HeadersProgressStore;
  filtersProgressStore: FiltersProgressStore;
  matchingProgressStore: MatchingProgressStore;
  blocksMatchedStore: BlocksMatchedStore;
  walletTxsStore: WalletTxsStore;
  receiveAddressStore?: ReceiveAddressStore;
};

function sessionOrDurableTotal(
  incoming: number | undefined,
  previous: number,
  downloaded: number,
): number {
  if (incoming !== undefined && incoming > 0) return incoming;
  if (previous > 0) return previous;
  return downloaded;
}

export function hydratePeers(db: Database, store: PeerSocketsStore): void {
  store.setKnown(db.peers.count());
}

export function hydrateHeaders(
  db: Database,
  store: HeadersProgressStore,
  peerTotal?: number,
  at: number = Date.now(),
): void {
  const tip = db.headers.tip();
  const minH = db.headers.minHeight();
  if (!tip || minH === null) return;
  // Match chain-headers: span after checkpoint, not inclusive row count.
  const downloaded = Math.max(0, tip.height - minH);
  const total = sessionOrDurableTotal(
    peerTotal,
    store.get().total,
    downloaded,
  );
  store.applyEvent({
    at,
    downloaded,
    total,
    height: tip.height,
  });
}

export function hydrateFilters(
  db: Database,
  store: FiltersProgressStore,
  rangeTotal?: number,
  at: number = Date.now(),
): void {
  const stored = db.filters.count();
  const total = sessionOrDurableTotal(
    rangeTotal,
    store.get().total,
    stored,
  );
  const downloaded = total > 0 ? Math.min(stored, total) : stored;
  store.applyEvent({ at, downloaded, total });
}

export function hydrateMatching(
  db: Database,
  store: MatchingProgressStore,
  at: number = Date.now(),
): void {
  const total = db.filters.count();
  store.applyEvent({
    at,
    scanned: db.filters.countScanned(),
    total,
  });
}

export function hydrateBlocks(
  db: Database,
  store: BlocksMatchedStore,
  at: number = Date.now(),
): void {
  store.applyEvent({
    at,
    downloaded: db.blocks.count(),
    matched: db.matchedBlocks.count(),
  });
}

export function hydrateWalletBlockCounts(
  db: Database,
  walletTxsStore: WalletTxsStore,
): void {
  walletTxsStore.setBlockCounts(
    db.parsedBlocks.count(),
    db.blocks.count(),
  );
}

function txSetUnchanged(db: Database, snap: WalletTxsSnapshot): boolean {
  if (snap.at === null) return false;
  const fp = db.transactions.fingerprint();
  return (
    fp.count === snap.txs.length &&
    BigInt(fp.netDeltaSum) === snap.balanceSats &&
    fp.newestTxid === (snap.txs[0]?.txid ?? null)
  );
}

export function hydrateWallet(
  db: Database,
  walletTxsStore: WalletTxsStore,
  receiveAddressStore: ReceiveAddressStore | undefined,
  wallet: Wallet | undefined,
  at: number,
): void {
  const parsed = db.parsedBlocks.count();
  const total = db.blocks.count();
  if (txSetUnchanged(db, walletTxsStore.get())) {
    walletTxsStore.setBlockCounts(parsed, total, at);
    // Gap growth can open a receive address without changing the tx set.
    if (
      receiveAddressStore &&
      wallet &&
      receiveAddressStore.get().address === null
    ) {
      receiveAddressStore.refresh(db, wallet);
    }
    return;
  }
  walletTxsStore.apply(snapshotFromDb(db, at, Date.now(), wallet));
  if (receiveAddressStore && wallet) {
    receiveAddressStore.refresh(db, wallet);
  }
}

export function hydrateFromDb(
  db: Database,
  stores: HydrateStores,
  wallet?: Wallet,
  at: number = Date.now(),
): void {
  hydratePeers(db, stores.peerSocketsStore);
  hydrateHeaders(db, stores.headersProgressStore, undefined, at);
  hydrateFilters(db, stores.filtersProgressStore, undefined, at);
  hydrateMatching(db, stores.matchingProgressStore, at);
  hydrateBlocks(db, stores.blocksMatchedStore, at);
  hydrateWallet(
    db,
    stores.walletTxsStore,
    stores.receiveAddressStore,
    wallet,
    at,
  );
}
