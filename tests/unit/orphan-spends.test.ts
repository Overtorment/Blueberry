import { describe, expect, test } from "bun:test";
import { Block, Transaction } from "bitcoinjs-lib";
import { p2pkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { requeueOrphanSpends } from "../../src/parse/orphan-spends.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function pubkey0(): Uint8Array {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  return new Uint8Array(root.derive("m/84'/0'/0'/0/0").publicKey!);
}

function wrapBlock(txs: Transaction[]): Uint8Array {
  const block = new Block();
  block.version = 1;
  block.prevHash = new Uint8Array(32);
  block.merkleRoot = Block.calculateMerkleRoot(txs);
  block.timestamp = 0;
  block.bits = 0;
  block.nonce = 0;
  block.transactions = txs;
  return block.toBuffer();
}

describe("requeueOrphanSpends", () => {
  test("clears parsed markers for downloaded blocks that spend current UTXOs", () => {
    const db = createSqliteDatabase(":memory:");
    const { script } = p2pkh(pubkey0());
    const watch = [new Uint8Array(script)];

    const receive = new Transaction();
    receive.version = 2;
    receive.addInput(Buffer.alloc(32), 0xffffffff);
    receive.addOutput(watch[0]!, 50_000n);

    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(
      new Uint8Array(Buffer.from(receive.getId(), "hex").reverse()),
      0,
    );
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 49_000n);

    db.blocks.insert({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
      block: wrapBlock([receive]),
    });
    db.blocks.insert({
      height: 20,
      blockHashInternalHex: "bb".repeat(32),
      block: wrapBlock([spend]),
    });
    db.parsedBlocks.mark(10);
    db.parsedBlocks.mark(20);
    db.transactions.upsert({
      txid: receive.getId(),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "aa".repeat(32),
      tx: receive.toBuffer(),
      netDeltaSats: 50_000,
    });

    expect(db.blocks.findHeightsContainingOutpoint(receive.getId(), 0, 10)).toEqual([
      20,
    ]);

    const cleared = requeueOrphanSpends(db, watch);
    expect(cleared).toBe(1);
    expect(db.parsedBlocks.has(20)).toBe(false);
    expect(db.parsedBlocks.has(10)).toBe(true);

    db.close();
  });
});
