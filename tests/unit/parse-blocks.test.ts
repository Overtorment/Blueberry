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
import { openTempFileLog } from "./file-log-harness.ts";

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
  test("parses backlog after sync:idle and emits wallet:txs", async () => {
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
    const file = openTempFileLog();
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(50) && db.transactions.count() === 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.list()[0]?.netDeltaSats).toBe(5000);

    // second start path: already parsed — still emits wallet:txs, no double insert
    await mod.stop();
    const text = file.read();
    file.close();
    expect(text).toContain("[parse-blocks] start");
    expect(text).toContain("[parse-blocks] allowed");
    expect(text).toContain("[parse-blocks] batch n=1 from=50 to=50");
    expect(text).toContain("[parse-blocks] stop");
    const before = events.length;
    const wallet2 = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
    const mod2 = createParseBlocksModule(
      { bus, db },
      { wallet: wallet2, idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod2.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => events.length > before);
    expect(db.transactions.count()).toBe(1);
    await mod2.stop();
    db.close();
  });

  test("blocks:progress while busy sets needsRun without overlapping parses", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    // Blocks 1+2 are seeded. The first sync:idle batch parses block 1; block 3 is
    // injected during the next batch after listNeedingParse runs, so needsRun must
    // schedule an immediate follow-up (not idleDelayMs).
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
        idleDelayMs: 50,
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
    bus.emit("sync:idle", { at: Date.now() });
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
      {
        wallet: createWallet(db, { secret: MNEMONIC, addressGap: 4 }),
        idleDelayMs: 50,
        blockGapMs: 0,
      },
    );
    const file = openTempFileLog();
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(11));
    expect(db.parsedBlocks.has(10)).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]?.detail).toContain("height 10");
    expect(db.transactions.count()).toBe(1);
    expect(db.transactions.list()[0]?.netDeltaSats).toBe(100);
    await mod.stop();
    expect(file.read()).toContain("[parse-blocks] decode height=10");
    file.close();
    db.close();
  });

  test("does not parse backlog until sync:idle", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    db.blocks.insert({
      height: 50,
      blockHashInternalHex: "ab".repeat(32),
      block: blockBytesWithReceive(script, 5000n),
    });

    let batches = 0;
    const wallet = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
    const mod = createParseBlocksModule(
      { bus, db },
      {
        wallet,
        idleDelayMs: 50,
        blockGapMs: 0,
        onParseBatch: () => {
          batches++;
        },
      },
    );
    await mod.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(batches).toBe(0);
    expect(db.parsedBlocks.has(50)).toBe(false);

    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(50) && db.transactions.count() === 1);
    expect(batches).toBeGreaterThanOrEqual(1);

    await mod.stop();
    db.close();
  });

  test("sync:catchup pauses parsing; sync:idle resumes", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    for (const h of [1, 2, 3]) {
      db.blocks.insert({
        height: h,
        blockHashInternalHex: h.toString(16).padStart(2, "0").repeat(32),
        block: blockBytesWithReceive(script, BigInt(h)),
      });
    }

    const wallet = createWallet(db, {
      secret: MNEMONIC,
      addressGap: config.gapLimit + 1,
    });
    let catchupEmitted = false;
    bus.on("wallet:txs", () => {
      if (catchupEmitted) return;
      catchupEmitted = true;
      bus.emit("sync:catchup", { at: Date.now(), reason: "blocks" });
    });
    const mod = createParseBlocksModule(
      { bus, db },
      {
        wallet,
        idleDelayMs: 50,
        batchSize: 1,
        blockGapMs: 30,
      },
    );
    const file = openTempFileLog();
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(1));
    await new Promise((r) => setTimeout(r, 120));
    expect(db.parsedBlocks.has(2)).toBe(false);
    expect(db.parsedBlocks.has(3)).toBe(false);
    expect(file.read()).toContain("[parse-blocks] paused");

    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(
      () =>
        db.parsedBlocks.has(2) &&
        db.parsedBlocks.has(3) &&
        db.transactions.count() === 3,
    );

    await mod.stop();
    file.close();
    db.close();
  });

  test("does not poll-parse while idle with an empty backlog", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    let batches = 0;
    const mod = createParseBlocksModule(
      { bus, db },
      {
        wallet: createWallet(db, { secret: MNEMONIC, addressGap: 4 }),
        idleDelayMs: 50,
        blockGapMs: 0,
        onParseBatch: () => {
          batches++;
        },
      },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => batches >= 1);
    await new Promise((r) => setTimeout(r, 180));
    expect(batches).toBe(1);
    await mod.stop();
    db.close();
  });

  test("drains a multi-batch backlog without waiting idleDelayMs", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    for (const h of [1, 2, 3]) {
      db.blocks.insert({
        height: h,
        blockHashInternalHex: h.toString(16).padStart(2, "0").repeat(32),
        block: blockBytesWithReceive(script, BigInt(h)),
      });
    }
    const started = Date.now();
    const mod = createParseBlocksModule(
      { bus, db },
      {
        wallet: createWallet(db, {
          secret: MNEMONIC,
          addressGap: config.gapLimit + 1,
        }),
        idleDelayMs: 5_000,
        batchSize: 1,
        blockGapMs: 0,
      },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(
      () =>
        db.parsedBlocks.has(1) &&
        db.parsedBlocks.has(2) &&
        db.parsedBlocks.has(3),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    await mod.stop();
    db.close();
  });

  test("decode error does not block later heights when batchSize is 1", async () => {
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

    const mod = createParseBlocksModule(
      { bus, db },
      {
        wallet: createWallet(db, { secret: MNEMONIC, addressGap: 4 }),
        idleDelayMs: 50,
        batchSize: 1,
        blockGapMs: 0,
      },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(11) && db.transactions.count() === 1);
    expect(db.parsedBlocks.has(10)).toBe(false);
    await mod.stop();
    db.close();
  });

  test("unexpected parseBatch error retries after backoff", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    db.blocks.insert({
      height: 7,
      blockHashInternalHex: "77".repeat(32),
      block: blockBytesWithReceive(script, 7n),
    });

    let batches = 0;
    const file = openTempFileLog();
    const mod = createParseBlocksModule(
      { bus, db },
      {
        wallet: createWallet(db, { secret: MNEMONIC, addressGap: 4 }),
        idleDelayMs: 50,
        blockGapMs: 0,
        onParseBatch: () => {
          batches++;
          if (batches === 1) throw new Error("boom");
        },
      },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(7) && db.transactions.count() === 1);
    await mod.stop();
    expect(file.read()).toContain("[parse-blocks] batch: boom");
    file.close();
    db.close();
  });

  test("catchup during a block gap pauses the next block until sync:idle", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    for (const h of [1, 2]) {
      db.blocks.insert({
        height: h,
        blockHashInternalHex: h.toString(16).padStart(2, "0").repeat(32),
        block: blockBytesWithReceive(script, BigInt(h)),
      });
    }

    let catchupScheduled = false;
    bus.on("wallet:txs", () => {
      if (catchupScheduled) return;
      catchupScheduled = true;
      setTimeout(() => {
        bus.emit("sync:catchup", { at: Date.now(), reason: "blocks" });
      }, 20);
    });

    const mod = createParseBlocksModule(
      { bus, db },
      {
        wallet: createWallet(db, {
          secret: MNEMONIC,
          addressGap: config.gapLimit + 1,
        }),
        idleDelayMs: 50,
        batchSize: 2,
        blockGapMs: 100,
      },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(1));
    await new Promise((r) => setTimeout(r, 150));
    expect(db.parsedBlocks.has(2)).toBe(false);

    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(2));

    await mod.stop();
    db.close();
  });
});
