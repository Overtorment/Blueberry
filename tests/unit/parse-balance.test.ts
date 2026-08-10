import { describe, expect, test } from "bun:test";
import { Transaction } from "bitcoinjs-lib";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  balanceFromTxs,
  buildUtxoMap,
  netDeltasForTxs,
} from "../../src/parse/balance.ts";
import { outpointKey } from "../../src/parse/extract.ts";
import {
  formatBtc,
  formatNetDelta,
  isSendMaxAmount,
  parseBtcToSats,
  shortTxid,
  splitBtc,
  utxoValueBar,
} from "../../src/parse/format.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function watchScript0(): { script: Uint8Array; pubkey: Uint8Array } {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const child = root.derive("m/84'/0'/0'/0/0");
  const pubkey = child.publicKey!;
  const { script } = p2wpkh(pubkey);
  return { script: new Uint8Array(script), pubkey: new Uint8Array(pubkey) };
}

describe("balanceFromTxs", () => {
  test("out-of-order spend-before-receive still balances", () => {
    const { script, pubkey } = watchScript0();
    const receive = new Transaction();
    receive.version = 2;
    receive.addInput(Buffer.alloc(32), 0xffffffff);
    receive.addOutput(script, 1000n);

    const spend = new Transaction();
    spend.version = 2;
    const prevHash = Buffer.from(receive.getId(), "hex").reverse();
    spend.addInput(new Uint8Array(prevHash), 0);
    spend.setWitness(0, [new Uint8Array(64), pubkey]);
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 900n);

    // Persist order inverted vs chain order
    const rows = [
      { txid: spend.getId(), height: 101, txIndex: 0, tx: spend.toBuffer() },
      { txid: receive.getId(), height: 100, txIndex: 0, tx: receive.toBuffer() },
    ];
    expect(balanceFromTxs(rows, [script])).toEqual({
      sats: 0n,
      utxoCount: 0,
    });
    const deltas = netDeltasForTxs(rows, [script]);
    expect(deltas.get(receive.getId())).toBe(1000n);
    expect(deltas.get(spend.getId())).toBe(-1000n);
  });
});

describe("format helpers", () => {
  test("btc and net-delta labels", () => {
    expect(formatBtc(1000n)).toBe("0.00001000 BTC");
    expect(formatNetDelta(100n)).toBe("+0.00000100 BTC");
    expect(formatNetDelta(-50n)).toBe("-0.00000050 BTC");
    expect(shortTxid("a".repeat(64))).toBe(`${"a".repeat(8)}…${"a".repeat(8)}`);
  });

  test("splitBtc peels trailing zeros and keeps one fractional digit", () => {
    expect(splitBtc(1000n)).toMatchObject({
      fracSignificant: "00001",
      fracTrailing: "000",
    });
    // Whole BTC: keep "0" bright, not an empty fraction.
    expect(splitBtc(100_000_000n)).toMatchObject({
      whole: "1",
      fracSignificant: "0",
      fracTrailing: "0000000",
    });
    expect(splitBtc(0n)).toMatchObject({
      fracSignificant: "0",
      fracTrailing: "0000000",
    });
    // No trailing pad when all 8 frac digits matter.
    expect(splitBtc(12_345_678n).fracTrailing).toBe("");
    expect(splitBtc(100n, { plus: true }).sign).toBe("+");
    expect(splitBtc(0n, { plus: true }).sign).toBe("");
    expect(splitBtc(-50n, { plus: true }).sign).toBe("-");
  });

  test("parseBtcToSats accepts decimals and rejects junk", () => {
    expect(parseBtcToSats("0.00001000")).toBe(1000n);
    expect(parseBtcToSats("1")).toBe(100000000n);
    expect(parseBtcToSats("0.5 BTC")).toBe(50000000n);
    expect(parseBtcToSats("")).toBeNull();
    expect(parseBtcToSats("abc")).toBeNull();
    expect(parseBtcToSats("0.000000001")).toBeNull();
    expect(parseBtcToSats("-1")).toBeNull();
  });

  test("isSendMaxAmount accepts trimmed case-insensitive max only", () => {
    expect(isSendMaxAmount("MAX")).toBe(true);
    expect(isSendMaxAmount(" Max ")).toBe(true);
    expect(isSendMaxAmount("maximum")).toBe(false);
    expect(isSendMaxAmount("")).toBe(false);
  });

  test("utxoValueBar uses full/partial/empty cells at fixed width", () => {
    expect(utxoValueBar(100n, 100n)).toBe("█".repeat(30));
    expect(utxoValueBar(50n, 100n)).toBe("█".repeat(15) + "░".repeat(15));
    // 1/3 of max → 10 full cells (80/8), no partial, rest empty
    expect(utxoValueBar(1n, 3n)).toBe("█".repeat(10) + "░".repeat(20));
    expect(utxoValueBar(0n, 100n)).toBe("");
    expect(utxoValueBar(1n, 0n)).toBe("");
    // Dust: at least one eighth-cell, padded to width
    expect(utxoValueBar(1n, 1_000_000n)).toBe("▏" + "░".repeat(29));
  });
});

describe("buildUtxoMap", () => {
  test("records height per outpoint; spend removes prior output", () => {
    const { script, pubkey } = watchScript0();
    const receive = new Transaction();
    receive.version = 2;
    receive.addInput(Buffer.alloc(32), 0xffffffff);
    receive.addOutput(script, 1000n);
    receive.addOutput(script, 500n);

    const map = buildUtxoMap(
      [
        {
          txid: receive.getId(),
          height: 200,
          txIndex: 0,
          tx: receive.toBuffer(),
        },
      ],
      [script],
    );
    expect(map.get(outpointKey(receive.getId(), 0))).toMatchObject({
      value: 1000n,
      height: 200,
    });
    expect(map.get(outpointKey(receive.getId(), 1))).toMatchObject({
      value: 500n,
      height: 200,
    });

    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(
      new Uint8Array(Buffer.from(receive.getId(), "hex").reverse()),
      0,
    );
    spend.setWitness(0, [new Uint8Array(64), pubkey]);
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 900n);

    const afterSpend = buildUtxoMap(
      [
        {
          txid: receive.getId(),
          height: 200,
          txIndex: 0,
          tx: receive.toBuffer(),
        },
        {
          txid: spend.getId(),
          height: 201,
          txIndex: 0,
          tx: spend.toBuffer(),
        },
      ],
      [script],
    );
    expect(afterSpend.has(outpointKey(receive.getId(), 0))).toBe(false);
    expect(afterSpend.get(outpointKey(receive.getId(), 1))).toMatchObject({
      value: 500n,
      height: 200,
    });
  });
});
