import { describe, expect, test } from "bun:test";
import { Block, Transaction } from "bitcoinjs-lib";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { config } from "../../src/config.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../../src/modules/parse-blocks.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("timeout"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function watchScript0(): Uint8Array {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const child = root.derive("m/84'/0'/0'/0/0");
  return new Uint8Array(p2wpkh(child.publicKey!).script);
}

function blockBytesWithReceive(script: Uint8Array, value: bigint): Uint8Array {
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

describe("parse-blocks", () => {
  test("parses backlog on start and emits wallet:txs", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    const blockBytes = blockBytesWithReceive(script, 5000n);
    db.blocks.insert({
      height: 50,
      blockHashInternalHex: "ab".repeat(32),
      block: blockBytes,
    });

    const events: number[] = [];
    bus.on("wallet:txs", (p) => events.push(p.at));

    const wallet = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
    const mod = createParseBlocksModule(
      { bus, db },
      { wallet, idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod.start();
    await waitFor(() => db.parsedBlocks.has(50) && db.transactions.count() === 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.list()[0]?.netDeltaSats).toBe(5000);

    // second start path: already parsed — still emits wallet:txs, no double insert
    await mod.stop();
    const before = events.length;
    const wallet2 = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
    const mod2 = createParseBlocksModule(
      { bus, db },
      { wallet: wallet2, idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod2.start();
    await waitFor(() => events.length > before);
    expect(db.transactions.count()).toBe(1);
    await mod2.stop();
    db.close();
  });

  test("blocks:progress while busy sets needsRun without overlapping parses", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    // Block 1 is parsed during start()'s initial batch (before blocks:progress subscribe).
    // Blocks 1+2 are seeded so the first background batch only fetches block 2; block 3 is
    // injected in onParseBatch after subscribe — listNeedingParse already ran for that batch,
    // so needsRun must schedule an immediate follow-up (not idleDelayMs).
    db.blocks.insert({
      height: 1,
      blockHashInternalHex: "11".repeat(32),
      block: blockBytesWithReceive(script, 1n),
    });
    db.blocks.insert({
      height: 2,
      blockHashInternalHex: "22".repeat(32),
      block: blockBytesWithReceive(script, 2n),
    });

    let batchDepth = 0;
    let overlapped = false;
    let parses = 0;
    // Window must exceed gapLimit so index 0 is outside the danger zone; otherwise
    // gap growth clears parsed marks and this test's batch sequencing breaks.
    const wallet = createWallet(db, {
      secret: MNEMONIC,
      addressGap: config.gapLimit + 1,
    });
    const mod = createParseBlocksModule(
      { bus, db },
      {
        wallet,
        idleDelayMs: 5000,
        batchSize: 1,
        blockGapMs: 0,
        onParseBatch: async () => {
          if (batchDepth > 0) overlapped = true;
          batchDepth++;
          parses++;
          if (parses === 2) {
            db.blocks.insert({
              height: 3,
              blockHashInternalHex: "33".repeat(32),
              block: blockBytesWithReceive(script, 3n),
            });
            bus.emit("blocks:progress", {
              at: Date.now(),
              downloaded: 3,
              matched: 3,
            });
          }
          batchDepth--;
        },
      },
    );
    await mod.start();
    await waitFor(
      () =>
        db.parsedBlocks.has(1) &&
        db.parsedBlocks.has(2) &&
        db.parsedBlocks.has(3),
    );
    expect(overlapped).toBe(false);
    expect(db.transactions.count()).toBe(3);
    await mod.stop();
    db.close();
  });

  test("decode error emits module:status and keeps parsing subsequent blocks", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    db.blocks.insert({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
      block: new Uint8Array([0x00, 0x01, 0x02]),
    });
    db.blocks.insert({
      height: 11,
      blockHashInternalHex: "bb".repeat(32),
      block: blockBytesWithReceive(script, 100n),
    });

    const errors: { detail?: string }[] = [];
    bus.on("module:status", (p) => {
      if (p.module === "parse-blocks" && p.status === "error") {
        errors.push({ detail: p.detail });
      }
    });

    const mod = createParseBlocksModule(
      { bus, db },
      { wallet: createWallet(db, { secret: MNEMONIC, addressGap: 4 }), idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod.start();
    await waitFor(() => db.parsedBlocks.has(11));
    expect(db.parsedBlocks.has(10)).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]?.detail).toContain("height 10");
    expect(db.transactions.count()).toBe(1);
    expect(db.transactions.list()[0]?.netDeltaSats).toBe(100);
    await mod.stop();
    db.close();
  });
});
