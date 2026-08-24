import { describe, expect, test } from "bun:test";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { Transaction as BjsTx } from "bitcoinjs-lib";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  buildActiveSendTx,
  pickUtxosByKeys,
  setActiveSendContext,
} from "../../src/tui/send-context.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import {
  encryptStoredWalletSecret,
  saveWalletSecret,
} from "../../src/wallet/secret.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

/** BlueWallet LegacyWallet */
const WIF_LEGACY = "L4ccWrPMmFDZw4kzAKFqJNxgHANjdy6b7YKNXMwB4xac4FLF3Tov";
const DEST = "1GX36PGBUrF8XahZEGQqHqnJGW2vCZteoB";
const ADDR_BECH32 = "bc1q3rl0mkyk0zrtxfmqn9wpcd3gnaz00yv9yp0hxe";

describe("buildActiveSendTx attachNonWitnessUtxos", () => {
  test("an unlocked encrypted WIF signs with its prev tx from DB", async () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, WIF_LEGACY);
    const secret = await encryptStoredWalletSecret(db, "pw");
    const wallet = createWallet(db, { secret });
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

describe("buildActiveSendTx address change", () => {
  test("change goes to the watched address for address wallets", () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ADDR_BECH32);
    const wallet = createWallet(db);
    setActiveSendContext(db, wallet);
    const script = wallet.snapshot().scripts[0]!;

    const result = buildActiveSendTx({
      utxos: [
        {
          txid: "11".repeat(32),
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: script,
        },
      ],
      toAddress: DEST,
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
    });

    expect(result.kind).toBe("psbt");
    if (result.kind !== "psbt") throw new Error("unreachable");
    expect(result.changeSats).toBeGreaterThan(0n);
    const tx = Transaction.fromPSBT(hex.decode(result.psbtHex));
    const outputs = [tx.getOutputAddress(0), tx.getOutputAddress(1)];
    expect(outputs).toContain(ADDR_BECH32);
    db.close();
  });
});

describe("pickUtxosByKeys", () => {
  const utxos = [
    { key: "a", valueSats: 1n },
    { key: "b", valueSats: 2n },
  ];

  test("returns selected UTXOs when every key is still present", () => {
    expect(pickUtxosByKeys(utxos, ["b", "a"])).toEqual({
      ok: true,
      selected: [utxos[0], utxos[1]],
    });
  });

  test("errors when a selected key disappeared", () => {
    expect(pickUtxosByKeys(utxos, ["a", "gone"])).toEqual({
      ok: false,
      error: "some selected UTXOs are no longer available",
    });
  });

  test("errors when nothing is selected", () => {
    expect(pickUtxosByKeys(utxos, [])).toEqual({
      ok: false,
      error: "no UTXOs selected",
    });
  });
});
