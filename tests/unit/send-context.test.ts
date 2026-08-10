import { describe, expect, test } from "bun:test";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { Transaction as BjsTx } from "bitcoinjs-lib";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  buildActiveSendTx,
  setActiveSendContext,
} from "../../src/tui/send-context.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import { saveWalletSecret } from "../../src/wallet/secret.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

/** BlueWallet LegacyWallet */
const WIF_LEGACY = "L4ccWrPMmFDZw4kzAKFqJNxgHANjdy6b7YKNXMwB4xac4FLF3Tov";
const DEST = "1GX36PGBUrF8XahZEGQqHqnJGW2vCZteoB";

describe("buildActiveSendTx attachNonWitnessUtxos", () => {
  test("attaches prev tx from DB for legacy p2pkh inputs", () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, WIF_LEGACY);
    const wallet = createWallet(db);
    setActiveSendContext(db, wallet);

    const watch = deriveWatchWallet(WIF_LEGACY);
    const recv = watch.addresses.find((a) => a.scriptType === "p2pkh");
    if (!recv) throw new Error("missing p2pkh");

    const fund = new BjsTx();
    fund.version = 2;
    const prevHash = Buffer.alloc(32);
    prevHash[0] = 42;
    fund.addInput(prevHash, 0);
    fund.addOutput(Buffer.from(recv.scriptPubKey), 100_000n);
    const fundTx = new Uint8Array(fund.toBuffer());
    const fundTxid = fund.getId();

    db.transactions.upsert({
      txid: fundTxid,
      height: 800_000,
      txIndex: 0,
      blockHashInternalHex: "aa".repeat(32),
      tx: fundTx,
      netDeltaSats: 100_000,
    });

    const result = buildActiveSendTx({
      utxos: [
        {
          txid: fundTxid,
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: recv.scriptPubKey,
          // intentionally omit nonWitnessUtxo — send-context must attach it
        },
      ],
      toAddress: DEST,
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
    });

    expect(result.kind).toBe("signed");
    if (result.kind !== "signed") throw new Error("unreachable");
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.isFinal).toBe(true);
    expect(tx.inputsLength).toBe(1);
    db.close();
  });
});
