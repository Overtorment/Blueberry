import { Transaction } from "bitcoinjs-lib";
import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createReceiveAddressStore } from "../../src/tui/receive-address-store.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function fundScript(script: Uint8Array, salt: number): Transaction {
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, salt), 0xffffffff);
  tx.addOutput(Buffer.from(script), 1000n);
  return tx;
}

describe("receive address store", () => {
  test("exhausted watch window grows and unwraps the next external", () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON, addressGap: 2 });
    for (const [i, addr] of wallet
      .snapshot()
      .addresses.filter((a) => !a.change)
      .entries()) {
      const tx = fundScript(addr.scriptPubKey, i + 1);
      db.transactions.upsert({
        txid: tx.getId(),
        height: 100 + i,
        txIndex: 0,
        blockHashInternalHex: "11".repeat(32),
        tx: tx.toBuffer(),
        netDeltaSats: 1000,
      });
    }

    const store = createReceiveAddressStore();
    store.refresh(db, wallet);

    const next = wallet
      .snapshot()
      .addresses.find((a) => !a.change && a.index === 2)!.address;
    expect(store.get().address).toBe(next);
    expect(wallet.gaps().external).toBeGreaterThan(2);
    db.close();
  });
});
