import { describe, expect, test } from "bun:test";
import { Block, Transaction } from "bitcoinjs-lib";
import { hexToBytes } from "bip158";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { config } from "../../src/config.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../../src/modules/parse-blocks.ts";
import { createWallet } from "../../src/wallet/wallet.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import { loadWatchGaps } from "../../src/wallet/watch-gaps.ts";
import { usedWatchIndexes } from "../../src/parse/used-indexes.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function blockBytesPaying(script: Uint8Array, value: bigint): Uint8Array {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32), 0xffffffff);
  tx.addOutput(script, value);
  const block = new Block();
  block.version = 1;
  block.prevHash = new Uint8Array(32);
  block.merkleRoot = Block.calculateMerkleRoot([tx]);
  block.timestamp = 0;
  block.bits = 0;
  block.nonce = 0;
  block.transactions = [tx];
  return block.toBuffer();
}

describe("parse-blocks gap growth", () => {
  test("used address in danger zone grows external and rematches from first used height", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    // Window 40 < gapLimit → danger zone is the whole window; index 25 → 40+gapLimit.
    const window = 40;
    const grown = window + config.gapLimit;
    const wallet = deriveWatchWallet(MNEMONIC, window);
    const danger = wallet.addresses.find((a) => !a.change && a.index === 25)!;

    // Wallet activity starts at height 3 → rematch filters >= 3 only.
    db.blocks.insert({
      height: 3,
      blockHashInternalHex: "aa".repeat(32),
      block: blockBytesPaying(danger.scriptPubKey, 1000n),
    });
    for (let h = 1; h <= 5; h++) {
      db.filters.append([
        {
          height: h,
          blockHashInternalHex: "bb".repeat(32),
          filter: hexToBytes("00"),
        },
      ]);
    }
    db.filters.markScanned([1, 2, 3, 4, 5]);

    const progress: Array<{ downloaded: number; total: number }> = [];
    bus.on("filters:progress", (p) =>
      progress.push({ downloaded: p.downloaded, total: p.total }),
    );

    const watch = createWallet(db, { secret: MNEMONIC, addressGap: window });
    const mod = createParseBlocksModule(
      { bus, db },
      { wallet: watch, idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => loadWatchGaps(db).external === grown);
    expect(loadWatchGaps(db).internal).toBe(window);
    expect(db.transactions.minHeight()).toBe(3);
    expect(db.filters.listNeedingMatch(10).map((f) => f.height)).toEqual([
      3, 4, 5,
    ]);
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress[0]?.downloaded).toBe(5);
    await mod.stop();
    db.close();
  });

  test("gap growth aborts the current batch so later heights use the new watchlist", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wide = deriveWatchWallet(MNEMONIC, 60);
    const danger = wide.addresses.find((a) => !a.change && a.index === 25)!;
    const next = wide.addresses.find((a) => !a.change && a.index === 45)!;

    db.blocks.insert({
      height: 3,
      blockHashInternalHex: "dd".repeat(32),
      block: blockBytesPaying(danger.scriptPubKey, 1000n),
    });
    db.blocks.insert({
      height: 4,
      blockHashInternalHex: "cc".repeat(32),
      block: blockBytesPaying(next.scriptPubKey, 2000n),
    });

    const watch = createWallet(db, { secret: MNEMONIC, addressGap: 40 });
    const mod = createParseBlocksModule(
      { bus, db },
      { wallet: watch, idleDelayMs: 50, batchSize: 8, blockGapMs: 0 },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => {
      const used = usedWatchIndexes(db.transactions.list(), watch.snapshot());
      return used.external.includes(45);
    });
    expect(db.transactions.count()).toBe(2);
    expect(loadWatchGaps(db).external).toBeGreaterThanOrEqual(90);
    await mod.stop();
    db.close();
  });

  test("gap growth re-parses already-downloaded blocks for newly watched indexes", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wide = deriveWatchWallet(MNEMONIC, 60);
    const danger = wide.addresses.find((a) => !a.change && a.index === 25)!;
    const next = wide.addresses.find((a) => !a.change && a.index === 45)!;

    // Already parsed under small watch (missed index 45); growth must re-parse it.
    db.blocks.insert({
      height: 4,
      blockHashInternalHex: "cc".repeat(32),
      block: blockBytesPaying(next.scriptPubKey, 2000n),
    });
    db.parsedBlocks.mark(4);
    db.blocks.insert({
      height: 3,
      blockHashInternalHex: "dd".repeat(32),
      block: blockBytesPaying(danger.scriptPubKey, 1000n),
    });

    const watch = createWallet(db, { secret: MNEMONIC, addressGap: 40 });
    const mod = createParseBlocksModule(
      { bus, db },
      { wallet: watch, idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => {
      const used = usedWatchIndexes(db.transactions.list(), watch.snapshot());
      return used.external.includes(45);
    });
    expect(loadWatchGaps(db).external).toBeGreaterThanOrEqual(90);
    await mod.stop();
    db.close();
  });
});
