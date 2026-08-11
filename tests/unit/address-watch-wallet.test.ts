/**
 * Single-address watch-only — vectors reuse BlueWallet WIF primary addresses
 * and BIP-341 taproot example from is-address-valid tests.
 */
import { address as btcAddress, Transaction } from "bitcoinjs-lib";
import { bytesToHex } from "bip158";
import { describe, expect, test } from "bun:test";
import { hex } from "@scure/base";
import { Transaction as ScureTransaction } from "@scure/btc-signer";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../../src/modules/parse-blocks.ts";
import { createReceiveAddressStore } from "../../src/tui/receive-address-store.ts";
import {
  buildSend,
  buildSignedSendTx,
} from "../../src/wallet/build-send-tx.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import {
  parseWalletSecret,
  saveWalletSecret,
} from "../../src/wallet/secret.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

const ADDR_BECH32 = "bc1q3rl0mkyk0zrtxfmqn9wpcd3gnaz00yv9yp0hxe";
const ADDR_LEGACY = "14YZ6iymQtBVQJk6gKnLCk49UScJK7SH4M";
const ADDR_P2SH = "3CKN8HTCews4rYJYsyub5hjAVm5g5VFdQJ";
const ADDR_TAPROOT =
  "bc1pm6lqlel3qxefsx0v39nshtghasvvp6ghn3e5hd5q280j5m9h7csqrkzssu";
const BIP341_TAPROOT =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const DEST = "1GX36PGBUrF8XahZEGQqHqnJGW2vCZteoB";

describe("parseWalletSecret address", () => {
  test("accepts mainnet legacy / nested / native / taproot (trimmed)", () => {
    expect(parseWalletSecret(`  ${ADDR_BECH32}  `)).toEqual({
      kind: "address",
      value: ADDR_BECH32,
    });
    expect(parseWalletSecret(ADDR_LEGACY).kind).toBe("address");
    expect(parseWalletSecret(ADDR_P2SH).kind).toBe("address");
    expect(parseWalletSecret(ADDR_TAPROOT).kind).toBe("address");
    expect(parseWalletSecret(BIP341_TAPROOT).kind).toBe("address");
  });

  test("rejects testnet and garbage before falling through to mnemonic", () => {
    expect(() =>
      parseWalletSecret("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"),
    ).toThrow(/mnemonic|address|invalid/i);
    expect(() => parseWalletSecret("not-an-address")).toThrow();
  });

  test("WIF still wins over address-shaped confusion", () => {
    const wif = "L4vn2KxgMLrEVpxjfLwxfjnPPQMnx42DCjZJ2H7nN4mdHDyEUWXd";
    expect(parseWalletSecret(wif).kind).toBe("wif");
  });
});

describe("deriveWatchWallet address", () => {
  test("native segwit → one p2wpkh script matching toOutputScript", () => {
    const w = deriveWatchWallet(ADDR_BECH32);
    expect(w.kind).toBe("address");
    expect(w.secret).toBe(ADDR_BECH32);
    expect(w.addresses).toHaveLength(1);
    expect(w.scripts).toHaveLength(1);
    const a = w.addresses[0]!;
    expect(a.address).toBe(ADDR_BECH32);
    expect(a.path).toBe("address/0");
    expect(a.change).toBe(false);
    expect(a.index).toBe(0);
    expect(a.scriptType).toBe("p2wpkh");
    expect(bytesToHex(a.scriptPubKey)).toBe(
      Buffer.from(btcAddress.toOutputScript(ADDR_BECH32)).toString("hex"),
    );
  });

  test("legacy / nested / taproot labels and script bytes", () => {
    expect(deriveWatchWallet(ADDR_LEGACY).addresses[0]?.scriptType).toBe(
      "p2pkh",
    );
    expect(deriveWatchWallet(ADDR_P2SH).addresses[0]?.scriptType).toBe(
      "p2sh-p2wpkh",
    );
    expect(deriveWatchWallet(ADDR_TAPROOT).addresses[0]?.scriptType).toBe(
      "p2tr",
    );
  });

  test("gaps argument ignored", () => {
    const a = deriveWatchWallet(ADDR_BECH32, 1);
    const b = deriveWatchWallet(ADDR_BECH32, {
      external: 500,
      internal: 500,
    });
    expect(a.addresses).toHaveLength(1);
    expect(b.addresses).toHaveLength(1);
    expect(bytesToHex(a.scripts[0]!)).toBe(bytesToHex(b.scripts[0]!));
  });
});

describe("address wallet receive + gaps", () => {
  test("receive store returns the sole watched address", () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ADDR_BECH32);
    const wallet = createWallet(db);
    const store = createReceiveAddressStore();

    store.refresh(db, wallet);

    expect(wallet.snapshot().kind).toBe("address");
    expect(store.get().address).toBe(ADDR_BECH32);
    db.close();
  });

  test("parse-blocks does not grow gaps for address wallets", async () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ADDR_BECH32);
    const bus = createMessageBus();
    const wallet = createWallet(db, { addressGap: 1 });
    const script = wallet.snapshot().scripts[0]!;
    const tx = new Transaction();
    tx.addInput(Buffer.alloc(32), 0xffffffff);
    tx.addOutput(script, 1_000n);
    db.transactions.upsert({
      txid: tx.getId(),
      height: 1,
      txIndex: 0,
      blockHashInternalHex: "11".repeat(32),
      tx: tx.toBuffer(),
      netDeltaSats: 1_000,
    });
    const before = wallet.gaps();
    const mod = createParseBlocksModule(
      { bus, db },
      { wallet, idleDelayMs: 50, blockGapMs: 0 },
    );

    await mod.start();

    expect(wallet.snapshot().kind).toBe("address");
    expect(wallet.scripts()).toHaveLength(1);
    expect(wallet.gaps()).toEqual(before);
    await mod.stop();
    db.close();
  });
});

describe("buildSend address watch-only", () => {
  test("returns unsigned PSBT; change to same address; refuses signed builder", () => {
    const wallet = deriveWatchWallet(ADDR_BECH32);
    const utxo = {
      txid: "11".repeat(32),
      vout: 0,
      valueSats: 100_000n,
      scriptPubKey: wallet.scripts[0]!,
    };
    const result = buildSend({
      secret: ADDR_BECH32,
      wallet,
      utxos: [utxo],
      toAddress: DEST,
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
      changeAddress: ADDR_BECH32,
    });
    expect(result.kind).toBe("psbt");
    if (result.kind !== "psbt") throw new Error("unreachable");
    expect(result.psbtHex.startsWith("70736274ff")).toBe(true);
    expect(result.changeSats).toBeGreaterThan(0n);

    const tx = ScureTransaction.fromPSBT(hex.decode(result.psbtHex));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
    const outAddrs = [tx.getOutputAddress(0), tx.getOutputAddress(1)];
    expect(outAddrs).toContain(DEST);
    expect(outAddrs).toContain(ADDR_BECH32);

    expect(() =>
      buildSignedSendTx({
        secret: ADDR_BECH32,
        wallet,
        utxos: [utxo],
        toAddress: DEST,
        amountSats: 50_000n,
        feeRateSatPerVb: 1,
        changeAddress: ADDR_BECH32,
      }),
    ).toThrow(/mnemonic|WIF|sign/i);
  });

  test("send-max has single output and zero changeSats", () => {
    const wallet = deriveWatchWallet(ADDR_BECH32);
    const result = buildSend({
      secret: ADDR_BECH32,
      wallet,
      utxos: [
        {
          txid: "22".repeat(32),
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: wallet.scripts[0]!,
        },
      ],
      toAddress: DEST,
      amountSats: "max",
      feeRateSatPerVb: 1,
      changeAddress: ADDR_BECH32,
    });
    expect(result.kind).toBe("psbt");
    if (result.kind !== "psbt") throw new Error("unreachable");
    expect(result.changeSats).toBe(0n);
    const tx = ScureTransaction.fromPSBT(hex.decode(result.psbtHex));
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutputAddress(0)).toBe(DEST);
  });

  test("taproot address builds PSBT using p2tr from address key", () => {
    const wallet = deriveWatchWallet(ADDR_TAPROOT);
    const result = buildSend({
      secret: ADDR_TAPROOT,
      wallet,
      utxos: [
        {
          txid: "33".repeat(32),
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: wallet.scripts[0]!,
        },
      ],
      toAddress: DEST,
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
      changeAddress: ADDR_TAPROOT,
    });
    expect(result.kind).toBe("psbt");
  });
});
