import { describe, expect, test } from "bun:test";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "bitcoinjs-lib";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  setActiveUtxoNamesContext,
  setUtxoName,
} from "../../src/tui/utxo-names-actions.ts";
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

describe("setUtxoName", () => {
  test("trims, upserts, clears on empty, refreshes wallet store", () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
    const store = createWalletTxsStore();
    setActiveUtxoNamesContext(db, wallet, store);

    const script = watchScript0();
    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32), 0xffffffff);
    tx.addOutput(script, 1000n);
    const outpoint = `${tx.getId()}:0`;
    db.transactions.upsert({
      txid: tx.getId(),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "aa".repeat(32),
      tx: tx.toBuffer(),
      netDeltaSats: 1000,
    });
    store.apply(snapshotFromDb(db, Date.now(), Date.now(), wallet));
    expect(store.get().utxos[0]?.name).toBeNull();

    setUtxoName(outpoint, "  coffee  ");
    expect(db.utxoNames.get(outpoint)).toBe("coffee");
    expect(store.get().utxos[0]?.name).toBe("coffee");

    setUtxoName(outpoint, "   ");
    expect(db.utxoNames.get(outpoint)).toBeNull();
    expect(store.get().utxos[0]?.name).toBeNull();

    db.close();
  });
});
