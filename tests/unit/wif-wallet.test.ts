/**
 * WIF single-key wallet — address vectors from BlueWallet:
 * - tests/unit/segwit-bech32-wallet.test.js
 * - tests/unit/legacy-wallet.test.js
 * - tests/unit/segwit-p2sh-wallet.test.js
 * - tests/unit/taproot-wallet.test.ts
 */
import { describe, expect, test } from "bun:test";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import { Transaction } from "@scure/btc-signer";
import { Transaction as BjsTx, script as bscript } from "bitcoinjs-lib";
import {
  buildSend,
  buildSignedSendTx,
} from "../../src/wallet/build-send-tx.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import { preferredWifReceiveAddress } from "../../src/wallet/receive-address.ts";
import { parseWalletSecret } from "../../src/wallet/secret.ts";
import type { WatchAddress } from "../../src/wallet/types.ts";

/** BlueWallet SegwitBech32Wallet */
const WIF_BECH32 = "L4vn2KxgMLrEVpxjfLwxfjnPPQMnx42DCjZJ2H7nN4mdHDyEUWXd";
const ADDR_BECH32 = "bc1q3rl0mkyk0zrtxfmqn9wpcd3gnaz00yv9yp0hxe";

/** BlueWallet LegacyWallet */
const WIF_LEGACY = "L4ccWrPMmFDZw4kzAKFqJNxgHANjdy6b7YKNXMwB4xac4FLF3Tov";
const ADDR_LEGACY = "14YZ6iymQtBVQJk6gKnLCk49UScJK7SH4M";

/** BlueWallet SegwitP2SHWallet */
const WIF_P2SH = "Ky1vhqYGCiCbPd8nmbUeGfwLdXB1h5aGwxHwpXrzYRfY5cTZPDo4";
const ADDR_P2SH = "3CKN8HTCews4rYJYsyub5hjAVm5g5VFdQJ";

/** BlueWallet TaprootWallet */
const WIF_TAPROOT = "L4PKRVk1Peaar5WuH5LiKfkTygWtFfGrFeH2g2t3YVVqiwpJjMoF";
const ADDR_TAPROOT = "bc1pm6lqlel3qxefsx0v39nshtghasvvp6ghn3e5hd5q280j5m9h7csqrkzssu";

const WIF_UNCOMPRESSED =
  "5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR";
const ADDR_UNCOMPRESSED = "1Jq6MksXQVWzrznvZzxkV6oY57oWXD9TXB";

const DEST_LEGACY = "1GX36PGBUrF8XahZEGQqHqnJGW2vCZteoB";

function byType(
  wallet: ReturnType<typeof deriveWatchWallet>,
  scriptType: WatchAddress["scriptType"],
): WatchAddress {
  const addr = wallet.addresses.find((a) => a.scriptType === scriptType);
  if (!addr) throw new Error(`missing ${scriptType}`);
  return addr;
}

function fundingTx(
  scriptPubKey: Uint8Array,
  valueSats: bigint,
  salt = 1,
): { txid: string; tx: Uint8Array } {
  const tx = new BjsTx();
  tx.version = 2;
  const prevHash = Buffer.alloc(32);
  prevHash[0] = salt;
  tx.addInput(prevHash, 0);
  tx.addOutput(Buffer.from(scriptPubKey), valueSats);
  return { txid: tx.getId(), tx: new Uint8Array(tx.toBuffer()) };
}

describe("parseWalletSecret WIF", () => {
  test("accepts compressed mainnet WIF (trimmed)", () => {
    expect(parseWalletSecret(`  ${WIF_BECH32}  `)).toEqual({
      kind: "wif",
      value: WIF_BECH32,
    });
    expect(parseWalletSecret(WIF_P2SH).kind).toBe("wif");
    expect(parseWalletSecret(WIF_TAPROOT).kind).toBe("wif");
  });

  test("accepts uncompressed mainnet WIF", () => {
    expect(
      parseWalletSecret(
        "5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR",
      ),
    ).toEqual({
      kind: "wif",
      value: "5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR",
    });
  });

  test("rejects garbage as WIF", () => {
    expect(() => parseWalletSecret("KnotAValidWifKeyxxxxxxxxxxx")).toThrow();
  });

  test("rejects testnet WIF with a clear mainnet-only error", () => {
    expect(() =>
      parseWalletSecret(
        "cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA",
      ),
    ).toThrow(/mainnet|testnet/i);
  });
});

describe("deriveWatchWallet WIF (BlueWallet address vectors)", () => {
  test("bech32 WIF unwraps to four types; native matches BlueWallet", () => {
    const w = deriveWatchWallet(WIF_BECH32);
    expect(w.kind).toBe("wif");
    expect(w.addresses).toHaveLength(4);
    expect(w.scripts).toHaveLength(4);
    expect(byType(w, "p2wpkh").address).toBe(ADDR_BECH32);
    expect(byType(w, "p2pkh").address).toBe(
      "1DVNNDU4sooWp6St9baaM8XQC9VYpwVcDi",
    );
    expect(byType(w, "p2sh-p2wpkh").address).toBe(
      "3QS6GoKXFCyhTRi7MqQ8vCGp8qxDRyk43J",
    );
    expect(byType(w, "p2tr").address.startsWith("bc1p")).toBe(true);
  });

  test("legacy / p2sh / taproot WIFs match BlueWallet primary addresses", () => {
    expect(byType(deriveWatchWallet(WIF_LEGACY), "p2pkh").address).toBe(
      ADDR_LEGACY,
    );
    expect(byType(deriveWatchWallet(WIF_P2SH), "p2sh-p2wpkh").address).toBe(
      ADDR_P2SH,
    );
    expect(byType(deriveWatchWallet(WIF_TAPROOT), "p2tr").address).toBe(
      ADDR_TAPROOT,
    );
  });

  test("gaps argument ignored for WIF", () => {
    const a = deriveWatchWallet(WIF_BECH32, 1);
    const b = deriveWatchWallet(WIF_BECH32, { external: 500, internal: 500 });
    expect(a.addresses.map((x) => x.address)).toEqual(
      b.addresses.map((x) => x.address),
    );
  });
});

describe("deriveWatchWallet uncompressed WIF", () => {
  test("watches only uncompressed legacy p2pkh", () => {
    const w = deriveWatchWallet(WIF_UNCOMPRESSED);
    expect(w.kind).toBe("wif");
    expect(w.addresses).toHaveLength(1);
    expect(w.scripts).toHaveLength(1);
    expect(w.addresses[0]?.scriptType).toBe("p2pkh");
    expect(w.addresses[0]?.address).toBe(ADDR_UNCOMPRESSED);
  });
});

describe("preferredWifReceiveAddress uncompressed", () => {
  test("defaults to the sole p2pkh when no txs", () => {
    const w = deriveWatchWallet(WIF_UNCOMPRESSED);
    const addr = preferredWifReceiveAddress(w, []);
    expect(addr.scriptType).toBe("p2pkh");
    expect(addr.address).toBe(ADDR_UNCOMPRESSED);
  });
});

describe("preferredWifReceiveAddress", () => {
  test("defaults to native segwit when no txs", () => {
    const w = deriveWatchWallet(WIF_BECH32);
    const addr = preferredWifReceiveAddress(w, []);
    expect(addr.scriptType).toBe("p2wpkh");
    expect(addr.address).toBe(ADDR_BECH32);
  });

  test("earliest touching output wins (legacy before later taproot)", () => {
    const w = deriveWatchWallet(WIF_BECH32);
    const legacy = byType(w, "p2pkh");
    const tap = byType(w, "p2tr");
    const fundLegacy = fundingTx(legacy.scriptPubKey, 10_000n, 1);
    const fundTap = fundingTx(tap.scriptPubKey, 10_000n, 2);
    const addr = preferredWifReceiveAddress(w, [
      { height: 200, txIndex: 0, tx: fundTap.tx },
      { height: 100, txIndex: 5, tx: fundLegacy.tx },
    ]);
    expect(addr.scriptType).toBe("p2pkh");
    expect(addr.address).toBe(legacy.address);
  });

  test("same height: lower txIndex wins", () => {
    const w = deriveWatchWallet(WIF_P2SH);
    const nested = byType(w, "p2sh-p2wpkh");
    const native = byType(w, "p2wpkh");
    const a = fundingTx(native.scriptPubKey, 1_000n, 3);
    const b = fundingTx(nested.scriptPubKey, 1_000n, 4);
    const addr = preferredWifReceiveAddress(w, [
      { height: 50, txIndex: 9, tx: a.tx },
      { height: 50, txIndex: 2, tx: b.tx },
    ]);
    expect(addr.scriptType).toBe("p2sh-p2wpkh");
  });

  test("spend of known watched outpoint counts as a touch", () => {
    const w = deriveWatchWallet(WIF_BECH32);
    const legacy = byType(w, "p2pkh");
    const native = byType(w, "p2wpkh");
    // Fund is in the set so the outpoint maps to legacy, but sorts after the spend.
    const fund = fundingTx(legacy.scriptPubKey, 10_000n, 30);
    const spend = new BjsTx();
    spend.version = 2;
    spend.addInput(Buffer.from(fund.txid, "hex").reverse(), 0);
    spend.addOutput(
      Buffer.from(hex.decode("76a914" + "11".repeat(20) + "88ac")),
      9_000n,
    );
    const laterNative = fundingTx(native.scriptPubKey, 1_000n, 31);
    const addr = preferredWifReceiveAddress(w, [
      { height: 200, txIndex: 0, tx: fund.tx },
      { height: 100, txIndex: 0, tx: new Uint8Array(spend.toBuffer()) },
      { height: 150, txIndex: 0, tx: laterNative.tx },
    ]);
    expect(addr.scriptType).toBe("p2pkh");
    expect(addr.address).toBe(legacy.address);
  });
});

describe("WIF signing (BlueWallet-style + mixed types)", () => {
  test("signs native segwit send with change (BlueWallet bech32 WIF)", () => {
    const wallet = deriveWatchWallet(WIF_BECH32);
    const recv = byType(wallet, "p2wpkh");
    const fund = fundingTx(recv.scriptPubKey, 100_000n, 7);
    const result = buildSignedSendTx({
      secret: WIF_BECH32,
      wallet,
      utxos: [
        {
          txid: fund.txid,
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: recv.scriptPubKey,
        },
      ],
      toAddress: DEST_LEGACY,
      amountSats: 90_000n,
      feeRateSatPerVb: 1,
      changeAddress: recv.address,
    });
    expect(result.kind).toBe("signed");
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.isFinal).toBe(true);
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
    expect(result.feeSats).toBe(BigInt(result.vsize));
  });

  test("signs wrapped segwit (BlueWallet p2sh WIF)", () => {
    const wallet = deriveWatchWallet(WIF_P2SH);
    const recv = byType(wallet, "p2sh-p2wpkh");
    const fund = fundingTx(recv.scriptPubKey, 300_000n, 8);
    const result = buildSignedSendTx({
      secret: WIF_P2SH,
      wallet,
      utxos: [
        {
          txid: fund.txid,
          vout: 0,
          valueSats: 300_000n,
          scriptPubKey: recv.scriptPubKey,
        },
      ],
      toAddress: DEST_LEGACY,
      amountSats: 90_000n,
      feeRateSatPerVb: 1,
      changeAddress: recv.address,
    });
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.isFinal).toBe(true);
    expect(Math.round(Number(result.feeSats) / result.vsize)).toBe(1);
  });

  test("signs legacy p2pkh with nonWitnessUtxo (BlueWallet legacy WIF)", () => {
    const wallet = deriveWatchWallet(WIF_LEGACY);
    const recv = byType(wallet, "p2pkh");
    const fund = fundingTx(recv.scriptPubKey, 100_000n, 9);
    const result = buildSignedSendTx({
      secret: WIF_LEGACY,
      wallet,
      utxos: [
        {
          txid: fund.txid,
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: recv.scriptPubKey,
          nonWitnessUtxo: fund.tx,
        },
      ],
      toAddress: DEST_LEGACY,
      amountSats: 90_000n,
      feeRateSatPerVb: 1,
      changeAddress: recv.address,
    });
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.isFinal).toBe(true);
    expect(tx.inputsLength).toBe(1);
  });

  test("signs taproot key-path (BlueWallet taproot WIF)", () => {
    const wallet = deriveWatchWallet(WIF_TAPROOT);
    const recv = byType(wallet, "p2tr");
    // BlueWallet utxo outpoint (witnessUtxo only — prev body not required)
    const result = buildSignedSendTx({
      secret: WIF_TAPROOT,
      wallet,
      utxos: [
        {
          txid: "4dc4c9a03dd7005310a313c5ef1754e5e53888d587073f01a5a662501c12ac3b",
          vout: 0,
          valueSats: 10_000n,
          scriptPubKey: recv.scriptPubKey,
        },
      ],
      toAddress: "13HaCAB4jf7FYSZexJxoczyDDnutzZigjS",
      amountSats: "max",
      feeRateSatPerVb: 4,
      changeAddress: recv.address,
    });
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.isFinal).toBe(true);
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutputAddress(0)).toBe("13HaCAB4jf7FYSZexJxoczyDDnutzZigjS");
    // BlueWallet vector uses the same outpoint / send-max @ 4 sat/vB; vsize may
    // differ slightly vs their coinselect, so assert feerate not exact hex.
    expect(result.feeSats).toBe(BigInt(Math.ceil(4 * result.vsize)));
    expect(tx.getOutput(0).amount).toBe(10_000n - result.feeSats);
  });

  test("signs mixed-type UTXOs in one transaction", () => {
    const wallet = deriveWatchWallet(WIF_BECH32);
    const types = [
      "p2pkh",
      "p2sh-p2wpkh",
      "p2wpkh",
      "p2tr",
    ] as const;
    const utxos = types.map((scriptType, i) => {
      const addr = byType(wallet, scriptType);
      const fund = fundingTx(addr.scriptPubKey, 100_000n, 20 + i);
      return {
        txid: fund.txid,
        vout: 0,
        valueSats: 100_000n,
        scriptPubKey: addr.scriptPubKey,
        nonWitnessUtxo: scriptType === "p2pkh" ? fund.tx : undefined,
      };
    });
    const change = byType(wallet, "p2wpkh").address;
    const result = buildSend({
      secret: WIF_BECH32,
      wallet,
      utxos,
      toAddress: DEST_LEGACY,
      amountSats: 200_000n,
      feeRateSatPerVb: 2,
      changeAddress: change,
    });
    expect(result.kind).toBe("signed");
    if (result.kind !== "signed") throw new Error("unreachable");
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.isFinal).toBe(true);
    expect(tx.inputsLength).toBe(4);
    expect(tx.outputsLength).toBe(2);
    // Classify each signed input from its unlock data (not the fixture list).
    const spentTypes = new Set<string>();
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i);
      const sig = inp.finalScriptSig ?? new Uint8Array();
      const wit = inp.finalScriptWitness ?? [];
      if (wit.length === 1 && sig.length === 0) spentTypes.add("p2tr");
      else if (wit.length >= 2 && sig.length === 0) spentTypes.add("p2wpkh");
      else if (wit.length >= 2 && sig.length > 0) spentTypes.add("p2sh-p2wpkh");
      else if (sig.length > 0) spentTypes.add("p2pkh");
      else throw new Error(`input ${i}: unrecognized unlock`);
    }
    expect(spentTypes).toEqual(
      new Set(["p2pkh", "p2sh-p2wpkh", "p2wpkh", "p2tr"]),
    );
  });

  test("legacy input without nonWitnessUtxo fails clearly", () => {
    const wallet = deriveWatchWallet(WIF_LEGACY);
    const recv = byType(wallet, "p2pkh");
    const fund = fundingTx(recv.scriptPubKey, 100_000n, 11);
    expect(() =>
      buildSignedSendTx({
        secret: WIF_LEGACY,
        wallet,
        utxos: [
          {
            txid: fund.txid,
            vout: 0,
            valueSats: 100_000n,
            scriptPubKey: recv.scriptPubKey,
          },
        ],
        toAddress: DEST_LEGACY,
        amountSats: 50_000n,
        feeRateSatPerVb: 1,
        changeAddress: recv.address,
      }),
    ).toThrow(/nonWitnessUtxo|legacy/i);
  });

  test("signs uncompressed legacy p2pkh", () => {
    const wallet = deriveWatchWallet(WIF_UNCOMPRESSED);
    const recv = wallet.addresses[0]!;
    const fund = fundingTx(recv.scriptPubKey, 100_000n, 41);
    const built = buildSend({
      secret: WIF_UNCOMPRESSED,
      wallet,
      utxos: [
        {
          txid: fund.txid,
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: recv.scriptPubKey,
          nonWitnessUtxo: fund.tx,
        },
      ],
      toAddress: DEST_LEGACY,
      amountSats: 40_000n,
      feeRateSatPerVb: 1,
      changeAddress: recv.address,
    });
    expect(built.kind).toBe("signed");
    if (built.kind !== "signed") throw new Error("expected signed");
    const tx = Transaction.fromRaw(hex.decode(built.txHex));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
  });

  // BIP69 (scure default) reorders inputs by txid bytes. Pass UTXOs in the
  // opposite order to check signing still produces a final, valid tx after
  // that reorder. Both inputs spend the same address/script, so this does
  // NOT prove that two *different* prevout scripts stay bound to the right
  // input — signWifTx always reads the script straight off each scure
  // input's own witnessUtxo, which scure itself keeps paired with that
  // input across the reorder.
  test("signs two uncompressed p2pkh UTXOs after BIP69 reorder", () => {
    const wallet = deriveWatchWallet(WIF_UNCOMPRESSED);
    const recv = wallet.addresses[0]!;
    // salt 1 txid bytes > salt 2; BIP69 puts salt-2 funding first
    const larger = fundingTx(recv.scriptPubKey, 80_000n, 1);
    const smaller = fundingTx(recv.scriptPubKey, 80_000n, 2);
    expect(
      Buffer.compare(
        Buffer.from(larger.txid, "hex"),
        Buffer.from(smaller.txid, "hex"),
      ),
    ).toBeGreaterThan(0);

    const built = buildSend({
      secret: WIF_UNCOMPRESSED,
      wallet,
      utxos: [
        {
          txid: larger.txid,
          vout: 0,
          valueSats: 80_000n,
          scriptPubKey: recv.scriptPubKey,
          nonWitnessUtxo: larger.tx,
        },
        {
          txid: smaller.txid,
          vout: 0,
          valueSats: 80_000n,
          scriptPubKey: recv.scriptPubKey,
          nonWitnessUtxo: smaller.tx,
        },
      ],
      toAddress: DEST_LEGACY,
      amountSats: 100_000n,
      feeRateSatPerVb: 1,
      changeAddress: recv.address,
    });
    expect(built.kind).toBe("signed");
    if (built.kind !== "signed") throw new Error("expected signed");
    const tx = Transaction.fromRaw(hex.decode(built.txHex));
    expect(tx.isFinal).toBe(true);
    expect(tx.inputsLength).toBe(2);
    expect(hex.encode(tx.getInput(0).txid!)).toBe(smaller.txid);
    expect(hex.encode(tx.getInput(1).txid!)).toBe(larger.txid);

    // Pin the legacy (SIGHASH_ALL) sighash bytes: verify each input's ECDSA
    // signature against a sighash computed independently by bitcoinjs-lib's
    // own hashForSignature. This is what replaces scure's private
    // tx.preimageLegacy — if our reimplementation ever produced the wrong
    // preimage (e.g. bound to the wrong prevout script or another input's
    // outpoint), these signatures would fail to verify.
    const bjsTx = BjsTx.fromHex(built.txHex);
    for (let i = 0; i < bjsTx.ins.length; i++) {
      const decompiled = bscript.decompile(bjsTx.ins[i]!.script);
      if (!decompiled || decompiled.length !== 2) {
        throw new Error(`input ${i}: expected [sig, pubkey] scriptSig`);
      }
      const [sigWithHashType, pubkey] = decompiled as [Buffer, Buffer];
      const hashType = sigWithHashType[sigWithHashType.length - 1]!;
      const signature = sigWithHashType.subarray(0, -1);
      const sighash = bjsTx.hashForSignature(i, recv.scriptPubKey, hashType);
      expect(
        secp256k1.verify(signature, sighash, pubkey, { lowS: false }),
      ).toBe(true);
    }
  });
});
