import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { sha256 } from "@noble/hashes/sha2";
import { hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction, script } from "bitcoinjs-lib";
import { discoverBip47Notification } from "../../src/wallet/bip47-discovery.ts";
import { buildBip47Notification } from "../../src/wallet/bip47-notification.ts";
import { blindPaymentCode, deriveBip47Account, paymentCodeFromAccount, serializeBip47Outpoint } from "../../src/wallet/bip47.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

const ALICE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BOB = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const aliceAccount = deriveBip47Account(ALICE);
const bobAccount = deriveBip47Account(BOB);
const aliceCode = paymentCodeFromAccount(aliceAccount);
const bobCode = paymentCodeFromAccount(bobAccount);
const wallet = deriveWatchWallet(ALICE, 2);
const watched = wallet.addresses[0]!;
const changeAddress = wallet.addresses.find((address) => address.change)!.address;
const txid = hex.encode(Uint8Array.from({ length: 32 }, (_, index) => index));
const built = buildBip47Notification({ secret: ALICE, wallet,
  utxos: [{ txid, vout: 0x01020304, valueSats: 100_000n, scriptPubKey: watched.scriptPubKey }],
  recipientPaymentCode: bobCode, feeRateSatPerVb: 1, changeAddress });
function transaction() { return Transaction.fromHex(built.txHex); }

describe("BIP47 incoming notification discovery", () => {
  test("recovers the code from the signed notification builder", () => {
    const tx = transaction();
    expect(discoverBip47Notification(tx, bobAccount)).toEqual({ senderPaymentCode: aliceCode,
      txid: built.txid, designatedInputIndex: 0 });
    expect(hex.encode(tx.ins[0]!.hash)).toBe(hex.encode(hex.decode(txid).reverse()));
    expect(tx.ins[0]!.index).toBe(0x01020304);
  });

  test("discovers a legacy compressed public key from the signature script", () => {
    const tx = transaction();
    const [signature, publicKey] = tx.ins[0]!.witness;
    tx.setInputScript(0, script.compile([signature!, publicKey!]));
    tx.setWitness(0, []);
    expect(discoverBip47Notification(tx, bobAccount)?.senderPaymentCode).toBe(aliceCode);
  });

  test("recognizes wrapped P2WPKH only when the program matches the exposed key", () => {
    const tx = transaction();
    const publicKey = tx.ins[0]!.witness[1]!;
    const redeem = new Uint8Array([0, 20, ...ripemd160(sha256(publicKey))]);
    tx.setInputScript(0, script.compile([redeem]));
    expect(discoverBip47Notification(tx, bobAccount)?.senderPaymentCode).toBe(aliceCode);
    redeem[2] = redeem[2]! ^ 1;
    tx.setInputScript(0, script.compile([redeem]));
    expect(discoverBip47Notification(tx, bobAccount)).toBeNull();
  });

  test("uses the first exposed key and does not try a later candidate", () => {
    const tx = transaction();
    const publicKey = tx.ins[0]!.witness[1]!;
    const otherKey = secp256k1.getPublicKey(new Uint8Array(32).fill(1), true);
    tx.setInputScript(0, script.compile([tx.ins[0]!.witness[0]!, publicKey, otherKey]));
    tx.setWitness(0, []);
    expect(discoverBip47Notification(tx, bobAccount)?.senderPaymentCode).toBe(aliceCode);
  });

  test("matches output scripts independently of output ordering", () => {
    const tx = transaction();
    tx.outs.reverse();
    expect(discoverBip47Notification(tx, bobAccount)?.senderPaymentCode).toBe(aliceCode);
  });

  test("ignores unrelated recipients, zero-value notifications and coinbase", () => {
    expect(discoverBip47Notification(transaction(), aliceAccount)).toBeNull();
    const zero = transaction(); zero.outs[0]!.value = 0n;
    expect(discoverBip47Notification(zero, bobAccount)).toBeNull();
    const coinbase = transaction(); coinbase.ins[0]!.hash = new Uint8Array(32); coinbase.ins[0]!.index = 0xffffffff;
    expect(discoverBip47Notification(coinbase, bobAccount)).toBeNull();
  });

  test("rejects multiple data carriers without accepting any candidate", () => {
    const duplicate = transaction(); duplicate.addOutput(duplicate.outs[1]!.script, 0n);
    expect(discoverBip47Notification(duplicate, bobAccount)).toBeNull();
    const unrelated = transaction(); unrelated.addOutput(script.compile([0x6a, Uint8Array.of(1, 2)]), 0n);
    expect(discoverBip47Notification(unrelated, bobAccount)).toBeNull();
  });

  test("ignores malformed, unsupported, nonminimal, and nonzero data outputs", () => {
    const payload = transaction().outs[1]!.script.slice(3);
    const invalidScripts = [
      new Uint8Array([0x6a, 0x4c, 79, ...payload.slice(0, 79)]),
      new Uint8Array([0x6a, 0x4d, 80, 0, ...payload]),
      new Uint8Array([0x6a, 0x4c, 80, ...payload, 0]),
    ];
    for (const offset of [0, 1, 2, 67, 79]) {
      const corrupt = payload.slice(); corrupt[offset] = 0xff;
      invalidScripts.push(new Uint8Array([0x6a, 0x4c, 80, ...corrupt]));
    }
    for (const dataScript of invalidScripts) {
      const tx = transaction(); tx.outs[1]!.script = dataScript;
      expect(discoverBip47Notification(tx, bobAccount)).toBeNull();
    }
    const nonzero = transaction(); nonzero.outs[1]!.value = 1n;
    expect(discoverBip47Notification(nonzero, bobAccount)).toBeNull();
  });

  test("rejects missing, malformed, uncompressed and ambiguous exposed keys", () => {
    for (const witness of [[], [Uint8Array.of(1)], [new Uint8Array(1), new Uint8Array(33)],
      [new Uint8Array(1), new Uint8Array(33).fill(2), Uint8Array.of(1)]]) {
      const tx = transaction(); tx.setWitness(0, witness);
      expect(discoverBip47Notification(tx, bobAccount)).toBeNull();
    }
    const uncompressed = transaction();
    const key = HDKey.fromMasterSeed(mnemonicToSeedSync(ALICE)).derive(watched.path).privateKey!;
    uncompressed.setInputScript(0, script.compile([uncompressed.ins[0]!.witness[0]!, secp256k1.getPublicKey(key, false)]));
    uncompressed.setWitness(0, []);
    expect(discoverBip47Notification(uncompressed, bobAccount)).toBeNull();
    const ambiguous = transaction();
    ambiguous.ins.unshift({ hash: new Uint8Array(32).fill(2), index: 0, script: script.compile([Uint8Array.of(1)]),
      sequence: 0xffffffff, witness: [] });
    expect(discoverBip47Notification(ambiguous, bobAccount)).toBeNull();
  });

  test("ignores self-notifications rather than creating an incoming self-channel", () => {
    const tx = transaction();
    const inputKey = HDKey.fromMasterSeed(mnemonicToSeedSync(ALICE)).derive(watched.path).privateKey!;
    const payload = blindPaymentCode({ paymentCode: bobCode, designatedPrivateKey: inputKey,
      recipientPaymentCode: bobCode, outpoint: serializeBip47Outpoint(txid, 0x01020304) });
    tx.outs[1]!.script = new Uint8Array([0x6a, 0x4c, 80, ...payload]);
    expect(discoverBip47Notification(tx, bobAccount)).toBeNull();
  });
});
