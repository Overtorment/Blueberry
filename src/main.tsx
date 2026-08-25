import { join } from "node:path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
  ensureDataDir,
  listDataDirs,
  resolveDataDir,
} from "./boot/data-dir.ts";
import { resolveOnboardingGate } from "./boot/onboarding-gate.ts";
import { reexecSelf } from "./boot/reexec.ts";
import { installFatalUnhandledRejection } from "./boot/unhandled-rejection.ts";
import { consensusForYear } from "./checkpoint.ts";
import { createMessageBus } from "./bus/message-bus.ts";
import { createSqliteDatabase } from "./db/sqlite-database.ts";
import type { Database } from "./db/types.ts";
import { initFileLog, log, logError, shouldEnableFileLog } from "./log.ts";
import { createBlocksDownloadModule } from "./modules/blocks-download.ts";
import { createChainHeadersModule } from "./modules/chain-headers.ts";
import { createFiltersDownloadModule } from "./modules/filters-download.ts";
import { createFiltersMatchingModule } from "./modules/filters-matching.ts";
import { createParseBlocksModule } from "./modules/parse-blocks.ts";
import { createPeersDiscoveryModule } from "./modules/peers-discovery.ts";
import { createBroadcastModule } from "./modules/broadcast/index.ts";
import { createSyncIdleModule } from "./modules/sync-idle.ts";
import type { Module } from "./modules/types.ts";
import { createNodePlatformNet } from "./net/node-platform.ts";
import { App } from "./tui/App.tsx";
import { createBlocksMatchedStore } from "./tui/blocks-matched-store.ts";
import { setActiveBroadcastBus } from "./tui/broadcast-actions.ts";
import { createBroadcastStore } from "./tui/broadcast-store.ts";
import { createFiltersProgressStore } from "./tui/filters-progress-store.ts";
import { createHeadersProgressStore } from "./tui/headers-progress-store.ts";
import { createMatchingProgressStore } from "./tui/matching-progress-store.ts";
import { createPeerSocketsStore } from "./tui/peer-sockets-store.ts";
import { createModuleStatusStore } from "./tui/status-store.ts";
import { shouldHardQuit } from "./tui/quit-key.ts";
import { createTuiModule } from "./tui/tui-module.ts";
import { createReceiveAddressStore } from "./tui/receive-address-store.ts";
import { createWalletTxsStore } from "./tui/wallet-txs-store.ts";
import { DataDirApp } from "./tui/DataDirApp.tsx";
import { EncryptApp } from "./tui/EncryptApp.tsx";
import { OnboardingApp } from "./tui/OnboardingApp.tsx";
import { UnlockApp } from "./tui/UnlockApp.tsx";
import { setActiveBlocksMatchedStore } from "./tui/use-blocks-matched.ts";
import { setActiveBroadcastStore } from "./tui/use-broadcast.ts";
import { setActiveFiltersProgressStore } from "./tui/use-filters-progress.ts";
import { setActiveHeadersProgressStore } from "./tui/use-headers-progress.ts";
import { setActiveMatchingProgressStore } from "./tui/use-matching-progress.ts";
import { setActiveStatusStore } from "./tui/use-module-status.ts";
import { setActivePeerSocketsStore } from "./tui/use-peer-sockets.ts";
import { setActiveReceiveAddressStore } from "./tui/use-receive-address.ts";
import { setActiveWalletTxsStore } from "./tui/use-wallet-txs.ts";
import { setActivePaymentLabelContext } from "./tui/payment-label-actions.ts";
import { setActiveSendContext } from "./tui/send-context.ts";
import { setActiveUtxoNamesContext } from "./tui/utxo-names-actions.ts";
import { createUiRouteStore } from "./tui/ui-route-store.ts";
import { setActiveUiRouteStore } from "./tui/use-ui-route.ts";
import {
  inspectSyncFromYear,
  latestCheckpointYear,
  loadSyncFromYear,
  saveSyncFromYear,
} from "./sync-year.ts";
import { markWalletBirthdayPending } from "./wallet/birthday.ts";
import {
  encryptStoredWalletSecret,
  inspectWalletSecret,
  saveWalletSecret,
  unlockStoredWalletSecret,
} from "./wallet/secret.ts";
import { createWallet } from "./wallet/wallet.ts";

installFatalUnhandledRejection({
  onRejection: (reason) => logError("main", "unhandledRejection", reason),
  exit: (code) => process.reallyExit(code),
});

try {
  const dataDir = await resolveOrPickDataDir();
  ensureDataDir(dataDir);
  if (shouldEnableFileLog(process.argv)) {
    initFileLog(join(dataDir, "blueberry.log"));
  }
  log("main", `boot dataDir=${dataDir}`);

  const db = createSqliteDatabase(join(dataDir, "blueberry.sqlite"));

  const gate = resolveOnboardingGate(
    inspectWalletSecret(db),
    inspectSyncFromYear(db),
  );

  if (gate.action === "exit-invalid") {
    log("main", `exit-invalid ${gate.detail}`);
    console.error(`wallet_secret is present but invalid: ${gate.detail}`);
    console.error(
      "Fix or delete the wallet_secret key in the database, then restart.",
    );
    process.reallyExit(1);
  }

  if (gate.action === "onboard") {
    log("main", "onboarding");
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
      exitSignals: [],
      useMouse: false,
    });

    function quitOnboarding(code: number, err?: unknown): void {
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
      if (err !== undefined) console.error(err);
      log("main", `onboarding quit code=${code}`);
      process.reallyExit(code);
    }

    function finishOnboarding(): void {
      try {
        root.unmount();
      } catch {
        /* ignore */
      }
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      reexecSelf();
    }

    const root = createRoot(renderer);
    root.render(
      <OnboardingApp
        startAtYearStep={gate.startAtYearStep}
        onSecretValidated={(raw) => {
          try {
            saveWalletSecret(db, raw);
          } catch (err) {
            quitOnboarding(1, err);
            return;
          }
        }}
        onWalletCreated={(raw) => {
          try {
            saveWalletSecret(db, raw);
            saveSyncFromYear(db, latestCheckpointYear());
            markWalletBirthdayPending(db);
          } catch (err) {
            quitOnboarding(1, err);
            return;
          }
          finishOnboarding();
        }}
        onYearChosen={(year) => {
          try {
            saveSyncFromYear(db, year);
          } catch (err) {
            quitOnboarding(1, err);
            return;
          }
          finishOnboarding();
        }}
      />,
    );

    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "c") quitOnboarding(0);
    });
    process.once("SIGINT", () => quitOnboarding(0));
    process.once("SIGTERM", () => quitOnboarding(0));
  } else if (gate.action === "encrypt" || gate.action === "unlock") {
    log("main", gate.action);
    await runProtectionGate(db, gate.action);
  }
} catch (err) {
  logError("main", "fatal boot", err);
  console.error(err instanceof Error ? err.message : String(err));
  process.reallyExit(1);
}

async function resolveOrPickDataDir(): Promise<string> {
  const decision = resolveDataDir(listDataDirs(process.cwd()));
  if (decision.action === "use") return decision.dir;
  return await pickDataDir(decision.dirs);
}

async function pickDataDir(dirs: string[]): Promise<string> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: false,
  });
  const root = createRoot(renderer);

  return await new Promise<string>((resolve) => {
    let finished = false;

    const onSignal = () => quit(0);

    function removeSignalListeners(): void {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }

    function quit(code: number): void {
      if (finished) return;
      finished = true;
      removeSignalListeners();
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
      log("main", `data-dir quit code=${code}`);
      process.reallyExit(code);
    }

    function finish(dir: string): void {
      if (finished) return;
      finished = true;
      removeSignalListeners();
      try {
        root.unmount();
      } catch {
        /* ignore */
      }
      try {
        renderer.destroy();
      } catch {
        /* ignore */
      }
      resolve(dir);
    }

    root.render(<DataDirApp dirs={dirs} onSelect={finish} />);
    renderer.keyInput.on("keypress", (key) => {
      if (key.ctrl && key.name === "c") quit(0);
    });
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

async function runProtectionGate(
  db: Database,
  action: "encrypt" | "unlock",
): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: false,
  });
  const root = createRoot(renderer);
  let finished = false;

  const onSignal = () => quit(0);

  function removeSignalListeners(): void {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  function quit(code: number, err?: unknown): void {
    if (finished) return;
    finished = true;
    removeSignalListeners();
    try {
      renderer.destroy();
    } catch {
      /* ignore */
    }
    if (err !== undefined) console.error(err);
    log("main", `${action} quit code=${code}`);
    process.reallyExit(code);
  }

  function goToApp(secret: string): void {
    if (finished) return;
    finished = true;
    removeSignalListeners();
    try {
      root.unmount();
    } catch {
      /* ignore */
    }
    try {
      renderer.destroy();
    } catch {
      /* ignore */
    }
    startApp(db, secret).catch((err) => {
      logError("main", "fatal boot", err);
      console.error(err instanceof Error ? err.message : String(err));
      process.reallyExit(1);
    });
  }

  function renderUnlock(): void {
    root.render(
      <UnlockApp
        onUnlock={async (password) => {
          const secret = await unlockStoredWalletSecret(db, password);
          log("main", "unlock ok");
          goToApp(secret);
        }}
      />,
    );
  }

  if (action === "encrypt") {
    root.render(
      <EncryptApp
        onSkip={() => {
          const wallet = inspectWalletSecret(db);
          if (wallet.status === "ok") {
            log("main", "encrypt skip");
            goToApp(wallet.value);
          } else if (wallet.status === "encrypted") {
            log("main", "encrypt skip blocked: wallet already encrypted");
            renderUnlock();
          } else {
            quit(
              1,
              new Error(
                wallet.status === "invalid"
                  ? wallet.detail
                  : "wallet_secret missing",
              ),
            );
          }
        }}
        onEncrypt={async (password) => {
          const secret = await encryptStoredWalletSecret(db, password);
          log("main", "encrypt saved");
          goToApp(secret);
        }}
      />,
    );
  } else {
    renderUnlock();
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") quit(0);
  });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
}

async function startApp(db: Database, secret: string): Promise<void> {
  const year = loadSyncFromYear(db);
  log("main", `startApp year=${year}`);
  const bus = createMessageBus();
  const net = createNodePlatformNet();
  const ctx = { bus, db };
  const statusStore = createModuleStatusStore();
  setActiveStatusStore(statusStore);
  const peerSocketsStore = createPeerSocketsStore();
  setActivePeerSocketsStore(peerSocketsStore);
  const headersProgressStore = createHeadersProgressStore();
  setActiveHeadersProgressStore(headersProgressStore);
  const filtersProgressStore = createFiltersProgressStore();
  setActiveFiltersProgressStore(filtersProgressStore);
  const matchingProgressStore = createMatchingProgressStore();
  setActiveMatchingProgressStore(matchingProgressStore);
  const blocksMatchedStore = createBlocksMatchedStore();
  setActiveBlocksMatchedStore(blocksMatchedStore);
  const walletTxsStore = createWalletTxsStore();
  setActiveWalletTxsStore(walletTxsStore);
  const receiveAddressStore = createReceiveAddressStore();
  setActiveReceiveAddressStore(receiveAddressStore);
  const uiRouteStore = createUiRouteStore();
  setActiveUiRouteStore(uiRouteStore);
  const broadcastStore = createBroadcastStore();
  setActiveBroadcastStore(broadcastStore);
  setActiveBroadcastBus(bus);

  const wallet = createWallet(db, { secret });
  setActiveSendContext(db, wallet);
  setActivePaymentLabelContext(db);
  setActiveUtxoNamesContext(db, wallet, walletTxsStore);

  const modules: Module[] = [
    createTuiModule(
      ctx,
      statusStore,
      peerSocketsStore,
      headersProgressStore,
      filtersProgressStore,
      matchingProgressStore,
      blocksMatchedStore,
      walletTxsStore,
      receiveAddressStore,
      wallet,
      broadcastStore,
    ),
    // Right after TUI so progress events seed tiles before heavy sync work.
    createBlocksDownloadModule(ctx, { net }),
    createSyncIdleModule(ctx),
    createPeersDiscoveryModule(ctx, { net }),
    createBroadcastModule(ctx),
    createChainHeadersModule(ctx, {
      net,
      consensus: consensusForYear(year),
    }),
    createFiltersDownloadModule(ctx, { net }),
    createParseBlocksModule(ctx, { wallet }),
    // Last: bip158 matching pins the event loop; start only after TUI + net modules.
    createFiltersMatchingModule(ctx, { wallet }),
  ];

  async function startModule(mod: Module): Promise<void> {
    try {
      await mod.start();
    } catch (err) {
      logError("main", `module start failed name=${mod.name}`, err);
      bus.emit("module:status", {
        module: mod.name,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // TUI hydrates from SQLite in start(), then React mounts. Domain modules
  // start after. First paint must not wait on domain events (avoids 0/0).
  const [tui, ...domainModules] = modules;
  await startModule(tui!);

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // Skip OpenTUI's default teardown — quit should be instant (no WAL checkpoint).
    exitSignals: [],
    useMouse: false,
  });
  createRoot(renderer).render(<App />);

  // Yield one frame so the first TUI paint lands before sync CPU work.
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 16);
    t.unref?.();
  });

  for (const mod of domainModules) {
    void startModule(mod);
  }

  let shuttingDown = false;

  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    // Committed writes are already in the WAL. Skip db.close() (WAL checkpoint),
    // skip renderer.destroy(), skip exit/beforeExit hooks — hard-stop now.
    log("main", "shutdown");
    process.reallyExit(0);
  }

  renderer.keyInput.on("keypress", (key) => {
    if (shouldHardQuit(key, renderer.currentFocusedEditor)) shutdown();
  });

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
