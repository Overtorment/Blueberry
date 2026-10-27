import { expect, test } from "bun:test";
import { Block, Transaction } from "bitcoinjs-lib";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../../src/modules/parse-blocks.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

test("a reorg during the parser yield cannot reinsert an orphan transaction", async () => {
  const db = createSqliteDatabase(":memory:");
  const bus = createMessageBus();
  const wallet = createWallet(db, { secret: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", addressGap: 2 });
  const tx = new Transaction();
  tx.addInput(new Uint8Array(32), 0xffffffff);
  tx.addOutput(wallet.snapshot().addresses[0]!.scriptPubKey, 1000n);
  const block = new Block();
  block.version = 1;
  block.prevHash = new Uint8Array(32);
  block.merkleRoot = Block.calculateMerkleRoot([tx]);
  block.transactions = [tx];
  db.blocks.insert({ height: 5, blockHashInternalHex: "aa".repeat(32), block: block.toBuffer() });
  let batches = 0;
  let rewound = false;
  const module = createParseBlocksModule({ db, bus }, { wallet, onParseBatch() {
    batches++;
    if (batches !== 1) return;
    setTimeout(() => { db.rewindAfter(4); rewound = true; }, 0);
  } });
  try {
    await module.start();
    bus.emit("sync:idle", { at: Date.now() });
    const deadline = Date.now() + 2000;
    while (!(rewound && batches >= 2)) {
      if (Date.now() > deadline) throw new Error("parser did not finish the reorg batch");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(db.transactions.get(tx.getId())).toBeNull();
    expect(db.parsedBlocks.has(5)).toBe(false);
  } finally {
    await module.stop();
    db.close();
  }
});
