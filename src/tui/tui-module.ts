import type { Module, ModuleContext } from "../modules/types.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { BlocksMatchedStore } from "./blocks-matched-store.ts";
import type { BroadcastStore } from "./broadcast-store.ts";
import type { FiltersProgressStore } from "./filters-progress-store.ts";
import type { HeadersProgressStore } from "./headers-progress-store.ts";
import {
  hydrateBlocks,
  hydrateFilters,
  hydrateFromDb,
  hydrateHeaders,
  hydrateMatching,
  hydratePeers,
  hydrateWallet,
  hydrateWalletBlockCounts,
} from "./hydrate.ts";
import type { MatchingProgressStore } from "./matching-progress-store.ts";
import type { PeerSocketsStore } from "./peer-sockets-store.ts";
import type { ReceiveAddressStore } from "./receive-address-store.ts";
import type { ModuleStatusStore } from "./status-store.ts";
import type { WalletTxsStore } from "./wallet-txs-store.ts";

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
      unsubs.push(
        ctx.bus.on("peers:updated", () => {
          hydratePeers(ctx.db, peerSocketsStore);
        }),
      );
      unsubs.push(
        ctx.bus.on("peers:sockets", (p) => {
          peerSocketsStore.applyEvent(p);
        }),
      );
      unsubs.push(
        ctx.bus.on("headers:progress", (p) => {
          hydrateHeaders(ctx.db, headersProgressStore, p.total, p.at);
        }),
      );
      unsubs.push(
        ctx.bus.on("filters:progress", (p) => {
          hydrateFilters(ctx.db, filtersProgressStore, p.total, p.at);
        }),
      );
      unsubs.push(
        ctx.bus.on("matching:progress", (p) => {
          hydrateMatching(ctx.db, matchingProgressStore, p.at);
        }),
      );
      unsubs.push(
        ctx.bus.on("blocks:progress", (p) => {
          hydrateBlocks(ctx.db, blocksMatchedStore, p.at);
          hydrateWalletBlockCounts(ctx.db, walletTxsStore);
        }),
      );
      unsubs.push(
        ctx.bus.on("filters:match", () => {
          hydrateBlocks(ctx.db, blocksMatchedStore);
        }),
      );
      unsubs.push(
        ctx.bus.on("wallet:txs", (p) => {
          hydrateWallet(
            ctx.db,
            walletTxsStore,
            receiveAddressStore,
            wallet,
            p.at,
          );
        }),
      );
      unsubs.push(
        ctx.bus.on("sync:idle", () => {
          walletTxsStore.setParsingActive(true);
        }),
      );
      unsubs.push(
        ctx.bus.on("sync:catchup", () => {
          walletTxsStore.setParsingActive(false);
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
      hydrateFromDb(
        ctx.db,
        {
          peerSocketsStore,
          headersProgressStore,
          filtersProgressStore,
          matchingProgressStore,
          blocksMatchedStore,
          walletTxsStore,
          receiveAddressStore,
        },
        wallet,
      );
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
