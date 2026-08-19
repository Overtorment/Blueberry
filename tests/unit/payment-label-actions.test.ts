import { describe, expect, test } from "bun:test";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  savePaymentLabel,
  setActivePaymentLabelContext,
} from "../../src/tui/payment-label-actions.ts";
import { outpointKey } from "../../src/parse/extract.ts";
import {
  buildSignedSendTx,
  changeOutputVouts,
} from "../../src/wallet/build-send-tx.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BLUE_EXTERNAL_1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const BLUE_INTERNAL_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";

function abandonWallet() {
  return deriveWatchWallet(MNEMONIC, { external: 2, internal: 2 });
}

function utxoAt(wallet: ReturnType<typeof deriveWatchWallet>, index = 0) {
  const recv = wallet.addresses.find((a) => !a.change && a.index === index)!;
  return {
    txid: "11".repeat(32),
    vout: 0,
    valueSats: 100_000n,
    scriptPubKey: recv.scriptPubKey,
  };
}

describe("savePaymentLabel", () => {
  test("trims label and stores change vouts for a built tx", () => {
    const db = createSqliteDatabase(":memory:");
    setActivePaymentLabelContext(db);
    const wallet = abandonWallet();
    const amountSats = 50_000n;
    const built = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [utxoAt(wallet)],
      toAddress: BLUE_EXTERNAL_1,
      amountSats,
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    });
    const tx = Transaction.fromRaw(hex.decode(built.txHex));
    const vouts = changeOutputVouts(
      tx,
      BLUE_INTERNAL_0,
      BLUE_EXTERNAL_1,
      amountSats,
    );

    savePaymentLabel({
      txid: built.txid,
      label: "  groceries  ",
      changeVouts: built.changeVouts,
    });

    expect(db.txPaymentLabels.get(built.txid)).toEqual({
      txid: built.txid,
      label: "groceries",
    });
    expect(db.utxoNames.get(outpointKey(built.txid, vouts[0]!))).toBe(
      "change from: groceries",
    );
    db.close();
  });

  test("send-max stores empty change vouts", () => {
    const db = createSqliteDatabase(":memory:");
    setActivePaymentLabelContext(db);
    const wallet = abandonWallet();
    const built = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [utxoAt(wallet)],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: "max",
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    });

    savePaymentLabel({
      txid: built.txid,
      label: "empty wallet",
      changeVouts: built.changeVouts,
    });

    expect(db.txPaymentLabels.get(built.txid)?.label).toBe("empty wallet");
    expect(db.utxoNames.list()).toEqual([]);
    db.close();
  });

  test("rejects a blank label", () => {
    const db = createSqliteDatabase(":memory:");
    setActivePaymentLabelContext(db);
    expect(() =>
      savePaymentLabel({ txid: "aa".repeat(32), label: "   ", changeVouts: [] }),
    ).toThrow("payment label is required");
    db.close();
  });
});
