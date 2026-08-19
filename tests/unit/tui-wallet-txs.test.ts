import { describe, expect, test } from "bun:test";
import { encodeBlockHeader } from "bitcoin-headers";
import { Transaction } from "bitcoinjs-lib";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createBlocksMatchedStore } from "../../src/tui/blocks-matched-store.ts";
import { createFiltersProgressStore } from "../../src/tui/filters-progress-store.ts";
import { createHeadersProgressStore } from "../../src/tui/headers-progress-store.ts";
import { createMatchingProgressStore } from "../../src/tui/matching-progress-store.ts";
import { createPeerSocketsStore } from "../../src/tui/peer-sockets-store.ts";
import { createModuleStatusStore } from "../../src/tui/status-store.ts";
import { createTuiModule } from "../../src/tui/tui-module.ts";
import {
  createWalletTxsStore,
  snapshotFromDb,
} from "../../src/tui/wallet-txs-store.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function watchScript0(): Uint8Array {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const child = root.derive("m/84'/0'/0'/0/0");
  const { script } = p2wpkh(child.publicKey!);
  return new Uint8Array(script);
}

function headerAt(timestamp: number): Uint8Array {
  return encodeBlockHeader({
    version: 1,
    previousBlockHash: new Uint8Array(32),
    merkleRoot: new Uint8Array(32),
    timestamp,
    bits: 0x1d00ffff,
    nonce: 0,
  });
}

function startTui(
  bus: ReturnType<typeof createMessageBus>,
  db: ReturnType<typeof createSqliteDatabase>,
  walletTxsStore: ReturnType<typeof createWalletTxsStore>,
) {
  const tui = createTuiModule(
    { bus, db },
    createModuleStatusStore(),
    createPeerSocketsStore(),
    createHeadersProgressStore(),
    createFiltersProgressStore(),
    createMatchingProgressStore(),
    createBlocksMatchedStore(),
    walletTxsStore,
  );
  tui.start();
  return tui;
}

describe("TUI wallet txs wiring", () => {
  test("seeds and refreshes txs, balance label, and parse backlog from DB events", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.blocks.insert({
      height: 1,
      blockHashInternalHex: "11".repeat(32),
      block: new Uint8Array([0xaa]),
    });
    db.blocks.insert({
      height: 2,
      blockHashInternalHex: "22".repeat(32),
      block: new Uint8Array([0xbb]),
    });
    db.transactions.upsert({
      txid: "ab".repeat(32),
      height: 1,
      txIndex: 0,
      blockHashInternalHex: "11".repeat(32),
      tx: new Uint8Array([0x00]),
      netDeltaSats: 1500,
    });

    const store = createWalletTxsStore();
    const tui = startTui(bus, db, store);

    // Seed: backlog visible, balance from summed deltas, newest-first list
    expect(store.get().blocksParsed).toBe(0);
    expect(store.get().blocksTotal).toBe(2);
    expect(store.get().balanceBtcLabel).toBe("0.00001500 BTC");
    expect(store.get().txs).toHaveLength(1);
    expect(store.get().txs[0]?.netDeltaLabel).toBe("+0.00001500 BTC");
    // No header yet → height fallback
    expect(store.get().txs[0]?.timeLabel).toBe("#1".padEnd(16));

    db.parsedBlocks.mark(1);
    db.transactions.upsert({
      txid: "cd".repeat(32),
      height: 2,
      txIndex: 0,
      blockHashInternalHex: "22".repeat(32),
      tx: new Uint8Array([0x00]),
      netDeltaSats: -500,
    });
    bus.emit("wallet:txs", { at: 10 });
    expect(store.get().at).toBe(10);
    expect(store.get().blocksParsed).toBe(1);
    expect(store.get().txs.map((t) => t.height)).toEqual([2, 1]);
    expect(store.get().balanceBtcLabel).toBe("0.00001000 BTC");

    const txsBefore = store.get().txs;
    db.blocks.insert({
      height: 3,
      blockHashInternalHex: "33".repeat(32),
      block: new Uint8Array([0xcc]),
    });
    bus.emit("blocks:progress", { at: 11, downloaded: 3, matched: 3 });
    expect(store.get().blocksTotal).toBe(3);
    expect(store.get().blocksParsed).toBe(1);
    expect(store.get().txs).toBe(txsBefore);

    bus.emit("wallet:txs", { at: 12 });
    expect(store.get().txs).toBe(txsBefore);
    expect(store.get().blocksTotal).toBe(3);
    expect(store.get().blocksParsed).toBe(1);

    tui.stop();
    db.close();
  });

  test("timeLabel decodes header timestamp", () => {
    const db = createSqliteDatabase(":memory:");
    const nowMs = 1_700_000_000_000;
    const ts = Math.floor(nowMs / 1000) - 3600;
    db.headers.append([
      {
        height: 1,
        hashInternalHex: "11".repeat(32),
        header: headerAt(ts),
        cumulativeWork: 1n,
      },
    ]);
    db.transactions.upsert({
      txid: "ab".repeat(32),
      height: 1,
      txIndex: 0,
      blockHashInternalHex: "11".repeat(32),
      tx: new Uint8Array([0x00]),
      netDeltaSats: 1,
    });
    const snap = snapshotFromDb(db, nowMs, nowMs);
    expect(snap.txs[0]?.timeLabel).toBe("1h ago".padEnd(16));
    expect(snap.utxos).toEqual([]);
    db.close();
  });

  test("forwards sync state so ETA is active-only", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    for (let height = 1; height <= 6; height++) {
      db.blocks.insert({
        height,
        blockHashInternalHex: `${height}`.repeat(32).padEnd(64, "0"),
        block: new Uint8Array([height]),
      });
    }

    const store = createWalletTxsStore();
    const tui = startTui(bus, db, store);

    expect(store.get().blocksTotal).toBe(6);
    expect(store.get().blocksParsed).toBe(0);
    expect(store.get().etaMs).toBeNull();

    bus.emit("sync:idle", { at: 1000 });
    db.parsedBlocks.mark(1);
    bus.emit("wallet:txs", { at: 1000 });
    expect(store.get().etaMs).toBeNull();
    db.parsedBlocks.mark(2);
    bus.emit("wallet:txs", { at: 2000 });
    expect(store.get().etaMs).toBe(4000);

    bus.emit("sync:catchup", { at: 2000, reason: "blocks" });
    expect(store.get().etaMs).toBeNull();

    db.parsedBlocks.mark(3);
    bus.emit("wallet:txs", { at: 1_000_000 });
    expect(store.get().etaMs).toBeNull();

    bus.emit("sync:idle", { at: 1_001_000 });
    db.parsedBlocks.mark(4);
    bus.emit("wallet:txs", { at: 1_001_000 });
    expect(store.get().etaMs).toBeNull();
    db.parsedBlocks.mark(5);
    bus.emit("wallet:txs", { at: 1_002_000 });
    expect(store.get().etaMs).toBe(1000);

    tui.stop();
    db.close();
  });

  test("snapshotFromDb lists UTXOs newest-first when wallet is provided", () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
    const script = watchScript0();
    const nowMs = 1_700_000_000_000;

    const older = new Transaction();
    older.version = 2;
    older.addInput(Buffer.alloc(32), 0xffffffff);
    older.addOutput(script, 1000n);

    const newer = new Transaction();
    newer.version = 2;
    newer.addInput(Buffer.alloc(32), 0xfffffffe);
    newer.addOutput(script, 500n);

    db.headers.append([
      {
        height: 10,
        hashInternalHex: "aa".repeat(32),
        header: headerAt(Math.floor(nowMs / 1000) - 86400),
        cumulativeWork: 1n,
      },
      {
        height: 20,
        hashInternalHex: "bb".repeat(32),
        header: headerAt(Math.floor(nowMs / 1000) - 3600),
        cumulativeWork: 2n,
      },
    ]);
    db.transactions.upsert({
      txid: older.getId(),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "aa".repeat(32),
      tx: older.toBuffer(),
      netDeltaSats: 1000,
    });
    db.transactions.upsert({
      txid: newer.getId(),
      height: 20,
      txIndex: 0,
      blockHashInternalHex: "bb".repeat(32),
      tx: newer.toBuffer(),
      netDeltaSats: 500,
    });
    db.txPaymentLabels.upsert({
      txid: newer.getId(),
      label: "lunch",
    });
    db.utxoNames.upsert(`${newer.getId()}:0`, "lunch money");

    const snap = snapshotFromDb(db, nowMs, nowMs, wallet);
    expect(snap.utxos.map((u) => u.height)).toEqual([20, 10]);
    expect(snap.utxos[0]?.valueSats).toBe(500n);
    expect(snap.utxos[0]?.ageLabel).toBe("1h ago".padEnd(16));
    expect(snap.utxos[0]?.outpointShort).toBe(
      `${newer.getId().slice(0, 6)}:0`,
    );
    expect(snap.utxos[0]?.name).toBe("lunch money");
    expect(snap.utxos[1]?.name).toBeNull();
    expect(snap.txs.find((t) => t.txid === newer.getId())?.paymentLabel).toBe(
      "lunch",
    );
    expect(snap.txs.find((t) => t.txid === older.getId())?.paymentLabel).toBeNull();
    db.close();
  });
});
