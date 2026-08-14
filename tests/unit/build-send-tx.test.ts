import { describe, expect, test } from "bun:test";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import {
  buildSend,
  buildSignedSendTx,
  buildUnsignedSendPsbt,
} from "../../src/wallet/build-send-tx.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

/**
 * BIP84 abandon / feerate checks from BlueWallet:
 * https://github.com/BlueWallet/BlueWallet/blob/master/tests/unit/hd-segwit-bech32-wallet.test.js
 */
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const BLUE_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

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

describe("buildSignedSendTx", () => {
  test("signs p2wpkh with change near the requested fee rate", () => {
    const wallet = abandonWallet();
    const feeRate = 10;
    const amountSats = 50_000n;
    const result = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [utxoAt(wallet)],
      toAddress: BLUE_EXTERNAL_1,
      amountSats,
      feeRateSatPerVb: feeRate,
      changeAddress: BLUE_INTERNAL_0,
    });

    const actualFeerate = Number(result.feeSats) / result.vsize;
    expect(Math.round(actualFeerate) >= feeRate).toBe(true);
    expect(actualFeerate <= feeRate + 1).toBe(true);

    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.isFinal).toBe(true);
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
    expect([tx.getOutputAddress(0), tx.getOutputAddress(1)]).toContain(
      BLUE_INTERNAL_0,
    );
    const destIdx =
      tx.getOutputAddress(0) === BLUE_EXTERNAL_1 ? 0 : 1;
    expect(tx.getOutput(destIdx).amount).toBe(amountSats);
  });

  test("1 sat/vB yields fee equal to vsize", () => {
    const wallet = abandonWallet();
    const result = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [utxoAt(wallet)],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: 10_000n,
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    });
    expect(result.feeSats).toBe(BigInt(result.vsize));
  });

  test("fractional fee rate uses ceil(rate × vsize)", () => {
    const wallet = abandonWallet();
    for (const feeRate of [0.5, 1.5]) {
      const result = buildSignedSendTx({
        secret: MNEMONIC,
        wallet,
        utxos: [utxoAt(wallet)],
        toAddress: BLUE_EXTERNAL_1,
        amountSats: 50_000n,
        feeRateSatPerVb: feeRate,
        changeAddress: BLUE_INTERNAL_0,
      });
      expect(result.feeSats).toBe(BigInt(Math.ceil(feeRate * result.vsize)));
    }
  });

  test("send-max: one output, no change, fee ceil(rate × vsize)", () => {
    const wallet = abandonWallet();
    const utxo = utxoAt(wallet);
    const feeRate = 1.5;
    const result = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [utxo],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: "max",
      feeRateSatPerVb: feeRate,
      changeAddress: BLUE_INTERNAL_0,
    });

    expect(result.changeSats).toBe(0n);
    expect(result.feeSats).toBe(BigInt(Math.ceil(feeRate * result.vsize)));

    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutputAddress(0)).toBe(BLUE_EXTERNAL_1);
    expect(tx.getOutput(0).amount).toBe(utxo.valueSats - result.feeSats);
  });

  test("send-max with multiple utxos uses all inputs and one output", () => {
    const wallet = abandonWallet();
    const a = utxoAt(wallet, 0);
    const b = {
      ...utxoAt(wallet, 1),
      txid: "22".repeat(32),
      valueSats: 80_000n,
    };
    const result = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [a, b],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: "max",
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    });

    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.inputsLength).toBe(2);
    expect(tx.outputsLength).toBe(1);
    expect(result.changeSats).toBe(0n);
    expect(tx.getOutput(0).amount).toBe(a.valueSats + b.valueSats - result.feeSats);
  });

  test("send-max rejects when leftover after fee would be a dust/zero output", () => {
    const wallet = abandonWallet();
    const utxo = { ...utxoAt(wallet), valueSats: 600n };
    expect(() =>
      buildSignedSendTx({
        secret: MNEMONIC,
        wallet,
        utxos: [utxo],
        toAddress: BLUE_EXTERNAL_1,
        amountSats: "max",
        feeRateSatPerVb: 1,
        changeAddress: BLUE_INTERNAL_0,
      }),
    ).toThrow(/insufficient/);
  });

  test("send-max rejects when a selected UTXO is uneconomical at the fee rate", () => {
    const wallet = abandonWallet();
    const big = utxoAt(wallet, 0);
    const tiny = {
      ...utxoAt(wallet, 1),
      txid: "22".repeat(32),
      valueSats: 30n,
    };
    expect(() =>
      buildSignedSendTx({
        secret: MNEMONIC,
        wallet,
        utxos: [big, tiny],
        toAddress: BLUE_EXTERNAL_1,
        amountSats: "max",
        feeRateSatPerVb: 1,
        changeAddress: BLUE_INTERNAL_0,
      }),
    ).toThrow(/uneconomical/);
  });

  test("non-max also rejects uneconomical selected UTXOs instead of signing a subset", () => {
    const wallet = abandonWallet();
    const big = utxoAt(wallet, 0);
    const tiny = {
      ...utxoAt(wallet, 1),
      txid: "22".repeat(32),
      valueSats: 30n,
    };
    expect(() =>
      buildSignedSendTx({
        secret: MNEMONIC,
        wallet,
        utxos: [big, tiny],
        toAddress: BLUE_EXTERNAL_1,
        amountSats: 50_000n,
        feeRateSatPerVb: 1,
        changeAddress: BLUE_INTERNAL_0,
      }),
    ).toThrow(/uneconomical/);
  });

  test("self-send (dest === change) keeps the payment and reports real change", () => {
    const wallet = abandonWallet();
    const utxo = utxoAt(wallet);
    const feeRate = 1.5;

    for (const amountSats of [10_000n, 50_000n]) {
      const result = buildSignedSendTx({
        secret: MNEMONIC,
        wallet,
        utxos: [utxo],
        toAddress: BLUE_INTERNAL_0,
        amountSats,
        feeRateSatPerVb: feeRate,
        changeAddress: BLUE_INTERNAL_0,
      });

      const tx = Transaction.fromRaw(hex.decode(result.txHex));
      expect(tx.outputsLength).toBe(2);
      const amounts = [
        tx.getOutput(0).amount,
        tx.getOutput(1).amount,
      ];
      expect(amounts).toContain(amountSats);
      expect(result.changeSats).toBe(
        utxo.valueSats - amountSats - result.feeSats,
      );
      expect(result.feeSats).toBe(
        BigInt(Math.ceil(feeRate * result.vsize)),
      );
    }
  });

  test("rejects zpub, empty utxos, bad amount/fee, and insufficient funds", () => {
    const wallet = abandonWallet();
    const utxo = utxoAt(wallet);
    const base = {
      wallet,
      utxos: [utxo],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    };

    expect(() =>
      buildSignedSendTx({ ...base, secret: BLUE_ZPUB }),
    ).toThrow(/mnemonic|WIF/);
    expect(() =>
      buildSignedSendTx({ ...base, secret: MNEMONIC, utxos: [] }),
    ).toThrow(/no UTXOs/);
    expect(() =>
      buildSignedSendTx({ ...base, secret: MNEMONIC, amountSats: 0n }),
    ).toThrow(/amount/);
    expect(() =>
      buildSignedSendTx({ ...base, secret: MNEMONIC, feeRateSatPerVb: 0 }),
    ).toThrow(/fee rate/);
    expect(() =>
      buildSignedSendTx({
        ...base,
        secret: MNEMONIC,
        amountSats: 200_000n,
      }),
    ).toThrow(/insufficient/);
    expect(() =>
      buildSignedSendTx({
        ...base,
        secret: MNEMONIC,
        toAddress: "not-an-address",
      }),
    ).toThrow(/invalid.*address/i);
  });
});

describe("buildSend / unsigned PSBT", () => {
  test("zpub returns unsigned PSBT; mnemonic returns signed tx", () => {
    const zWallet = deriveWatchWallet(BLUE_ZPUB, { external: 2, internal: 1 });
    const psbt = buildSend({
      secret: BLUE_ZPUB,
      wallet: zWallet,
      utxos: [utxoAt(zWallet)],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: 50_000n,
      feeRateSatPerVb: 10,
      changeAddress: BLUE_INTERNAL_0,
    });
    expect(psbt.kind).toBe("psbt");
    if (psbt.kind !== "psbt") throw new Error("unreachable");
    expect(psbt.psbtHex.startsWith("70736274ff")).toBe(true);
    expect(psbt.changeSats).toBeGreaterThan(0n);
    // Same builder without secret keys still works.
    expect(
      buildUnsignedSendPsbt({
        secret: BLUE_ZPUB,
        wallet: zWallet,
        utxos: [utxoAt(zWallet)],
        toAddress: BLUE_EXTERNAL_1,
        amountSats: 50_000n,
        feeRateSatPerVb: 10,
        changeAddress: BLUE_INTERNAL_0,
      }).psbtHex,
    ).toBe(psbt.psbtHex);

    const mWallet = abandonWallet();
    const signed = buildSend({
      secret: MNEMONIC,
      wallet: mWallet,
      utxos: [utxoAt(mWallet)],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    });
    expect(signed.kind).toBe("signed");
    if (signed.kind !== "signed") throw new Error("unreachable");
    expect(Transaction.fromRaw(hex.decode(signed.txHex)).isFinal).toBe(true);
  });

  test("zpub send-max returns a single-output unsigned PSBT with no change", () => {
    const zWallet = deriveWatchWallet(BLUE_ZPUB, { external: 2, internal: 1 });
    const utxo = utxoAt(zWallet);
    const result = buildSend({
      secret: BLUE_ZPUB,
      wallet: zWallet,
      utxos: [utxo],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: "max",
      feeRateSatPerVb: 10,
      changeAddress: BLUE_INTERNAL_0,
    });

    expect(result.kind).toBe("psbt");
    if (result.kind !== "psbt") throw new Error("unreachable");
    expect(result.changeSats).toBe(0n);

    const tx = Transaction.fromPSBT(hex.decode(result.psbtHex));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutputAddress(0)).toBe(BLUE_EXTERNAL_1);
    expect(tx.getOutput(0).amount).toBe(utxo.valueSats - result.feeSats);
  });
});
