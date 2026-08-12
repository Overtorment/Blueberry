import { describe, expect, test } from "bun:test";
import { Block, Transaction } from "bitcoinjs-lib";
import { buildBasicFilter, bytesToHex, hexToBytes } from "bip158";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { scanFiltersForMatches } from "../../src/match/scan.ts";
import { createParseBlocksModule } from "../../src/modules/parse-blocks.ts";
import { createWallet } from "../../src/wallet/wallet.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

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

function internalHexToDisplay(internalHex: string): Uint8Array {
  const internal = hexToBytes(internalHex);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = internal[31 - i]!;
  return out;
}

function filterContaining(scripts: Uint8Array[], internalHex: string): string {
  return bytesToHex(
    buildBasicFilter({
      blockHashDisplay: internalHexToDisplay(internalHex),
      elements: scripts,
    }),
  );
}

function blockBytesPaying(script: Uint8Array, value: bigint): {
  block: Uint8Array;
  txid: string;
} {
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
  return { block: block.toBuffer(), txid: tx.getId() };
}

describe("idempotent blocks + txs (rematch)", () => {
  test("rematch does not re-queue download or parse; tx stays unique", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const wallet = deriveWatchWallet(MNEMONIC, 4);
    const script = wallet.scripts[0]!;
    const hash = "ab".repeat(32);
    const { block, txid } = blockBytesPaying(script, 1000n);

    db.filters.append([
      {
        height: 100,
        blockHashInternalHex: hash,
        filter: hexToBytes(filterContaining([script], hash)),
      },
    ]);
    db.matchedBlocks.insert({ height: 100, blockHashInternalHex: hash });
    expect(db.blocks.insert({ height: 100, blockHashInternalHex: hash, block })).toBe(
      true,
    );
    expect(
      db.blocks.insert({ height: 100, blockHashInternalHex: hash, block }),
    ).toBe(false);

    const watchWallet = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
    const mod = createParseBlocksModule(
      { bus, db },
      { wallet: watchWallet, idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod.start();
    bus.emit("sync:idle", { at: Date.now() });
    await waitFor(() => db.parsedBlocks.has(100) && db.transactions.count() === 1);
    expect(db.transactions.list()[0]?.txid).toBe(txid);
    expect(db.matchedBlocks.listNeedingDownload(10)).toEqual([]);
    expect(db.blocks.listNeedingParse(10)).toEqual([]);

    const matches: number[] = [];
    db.filters.markUnscanned([100]);
    await scanFiltersForMatches(
      db,
      wallet.scripts,
      { onMatch: (m) => matches.push(m.height) },
      { yieldFn: async () => {}, batchGapMs: 0 },
    );
    expect(matches).toEqual([]);
    expect(db.matchedBlocks.count()).toBe(1);
    expect(db.matchedBlocks.listNeedingDownload(10)).toEqual([]);
    expect(db.blocks.listNeedingParse(10)).toEqual([]);
    expect(db.transactions.count()).toBe(1);

    await mod.stop();
    db.close();
  });
});
