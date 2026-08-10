import type { Module, ModuleContext } from "../modules/types.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { BlocksMatchedStore } from "./blocks-matched-store.ts";
import type { BroadcastStore } from "./broadcast-store.ts";
import type { FiltersProgressStore } from "./filters-progress-store.ts";
import type { HeadersProgressStore } from "./headers-progress-store.ts";
import type { MatchingProgressStore } from "./matching-progress-store.ts";
import type { PeerSocketsStore } from "./peer-sockets-store.ts";
import type { ReceiveAddressStore } from "./receive-address-store.ts";
import type { ModuleStatusStore } from "./status-store.ts";
import type { WalletTxsStore } from "./wallet-txs-store.ts";
import { snapshotFromDb } from "./wallet-txs-store.ts";

export function createTuiModule(
  ctx: ModuleContext,
  store: ModuleStatusStore,
  peerSocketsStore: PeerSocketsStore,
  headersProgressStore: HeadersProgressStore,
  filtersProgressStore: FiltersProgressStore,
  matchingProgressStore: MatchingProgressStore,
  blocksMatchedStore: BlocksMatchedStore,
  walletTxsStore: WalletTxsStore,
  receiveAddressStore?: ReceiveAddressStore,
  wallet?: Wallet,
  broadcastStore?: BroadcastStore,
): Module {
  const unsubs: Array<() => void> = [];

  function refreshWalletUi(at: number): void {
    walletTxsStore.apply(snapshotFromDb(ctx.db, at, Date.now(), wallet));
    if (receiveAddressStore && wallet) {
      receiveAddressStore.refresh(ctx.db, wallet);
    }
  }

  return {
    name: "tui",
    start() {
      unsubs.push(
        ctx.bus.on("module:status", (payload) => {
          store.set(payload.module, {
            status: payload.status,
            detail: payload.detail,
          });
        }),
      );
      // Seed progress tiles from DB so the first paint isn't 0/0 while
      // peers/headers/filters modules are still starting.
      const filterTotal = ctx.db.filters.count();
      const headersTip = ctx.db.headers.tip();
      const headersMin = ctx.db.headers.minHeight();
      if (headersTip && headersMin !== null) {
        headersProgressStore.applyEvent({
          at: Date.now(),
          downloaded: Math.max(0, headersTip.height - headersMin + 1),
          total: Math.max(0, headersTip.height - headersMin + 1),
          height: headersTip.height,
        });
      }
      filtersProgressStore.applyEvent({
        at: Date.now(),
        downloaded: filterTotal,
        total: filterTotal,
      });
      matchingProgressStore.applyEvent({
        at: Date.now(),
        scanned: ctx.db.filters.countScanned(),
        total: filterTotal,
      });
      blocksMatchedStore.applyEvent({
        at: Date.now(),
        downloaded: ctx.db.blocks.count(),
        matched: ctx.db.matchedBlocks.count(),
      });
      refreshWalletUi(Date.now());
      peerSocketsStore.setKnown(ctx.db.peers.count());
      unsubs.push(
        ctx.bus.on("peers:updated", () => {
          peerSocketsStore.setKnown(ctx.db.peers.count());
        }),
      );
      unsubs.push(
        ctx.bus.on("peers:sockets", (p) => {
          peerSocketsStore.applyEvent(p);
        }),
      );
      unsubs.push(
        ctx.bus.on("headers:progress", (p) => {
          headersProgressStore.applyEvent(p);
        }),
      );
      unsubs.push(
        ctx.bus.on("filters:progress", (p) => {
          filtersProgressStore.applyEvent(p);
        }),
      );
      unsubs.push(
        ctx.bus.on("matching:progress", (p) => {
          matchingProgressStore.applyEvent(p);
        }),
      );
      unsubs.push(
        ctx.bus.on("blocks:progress", (p) => {
          blocksMatchedStore.applyEvent({
            at: p.at,
            downloaded: p.downloaded,
            matched: p.matched,
          });
          refreshWalletUi(p.at);
        }),
      );
      unsubs.push(
        ctx.bus.on("filters:match", () => {
          blocksMatchedStore.setMatched(ctx.db.matchedBlocks.count());
        }),
      );
      unsubs.push(
        ctx.bus.on("wallet:txs", (p) => {
          refreshWalletUi(p.at);
        }),
      );
      if (broadcastStore) {
        unsubs.push(
          ctx.bus.on("broadcast:progress", (p) => {
            broadcastStore.applyProgress(p);
          }),
        );
        unsubs.push(
          ctx.bus.on("broadcast:done", (p) => {
            broadcastStore.applyDone(p);
          }),
        );
      }
      ctx.bus.emit("module:status", { module: "tui", status: "starting" });
      ctx.bus.emit("module:status", { module: "tui", status: "running" });
    },
    stop() {
      for (const off of unsubs) off();
      unsubs.length = 0;
      ctx.bus.emit("module:status", { module: "tui", status: "stopped" });
    },
  };
}
