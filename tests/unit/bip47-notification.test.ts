import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hex } from "@scure/base";
import { p2pkh, Transaction } from "@scure/btc-signer";
import { Transaction as BitcoinTransaction } from "bitcoinjs-lib";
import { buildBip47Notification } from "../../src/wallet/bip47-notification.ts";
import { deriveBip47Account, paymentCodeFromAccount, serializeBip47Outpoint, unblindPaymentCode } from "../../src/wallet/bip47.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BOB_MNEMONIC = "reward upper indicate eight swift arch injury crystal super wrestle already dentist";
const bobAccount = deriveBip47Account(BOB_MNEMONIC);
const BOB_CODE = paymentCodeFromAccount(bobAccount);

function setup(values = [100_000n]) {
  const wallet = deriveWatchWallet(MNEMONIC, { external: values.length, internal: 1 });
  const utxos = values.map((valueSats, index) => ({ txid: (index + 1).toString(16).padStart(2, "0").repeat(32),
    vout: index, valueSats, scriptPubKey: wallet.addresses[index]!.scriptPubKey }));
  return { secret: MNEMONIC, wallet, utxos, recipientPaymentCode: BOB_CODE, feeRateSatPerVb: 1,
    changeAddress: wallet.addresses.find((address) => address.change)!.address };
}

describe("BIP47 notification transaction construction", () => {
  test("signs all inputs and binds the notification to the actual first serialized outpoint", () => {
    const params = setup([50_000n, 70_000n]);
    params.utxos.reverse();
    const result = buildBip47Notification(params);
    const tx = BitcoinTransaction.fromHex(result.txHex);
    expect(result.txid).toBe(tx.getId());
    expect(result.vsize).toBe(tx.virtualSize());
    expect(result.changeVouts).toEqual([2]);
    expect(tx.outs[0]!.value).toBe(546n);
    expect(tx.outs[1]!.value).toBe(0n);
    expect(hex.encode(tx.outs[1]!.script.slice(0, 3))).toBe("6a4c50");
    expect(tx.outs[1]!.script.length).toBe(83);
    const first = tx.ins[0]!;
    const outpoint = serializeBip47Outpoint(hex.encode(first.hash.slice().reverse()), first.index);
    expect(unblindPaymentCode({ payload: tx.outs[1]!.script.slice(3), recipientAccount: bobAccount,
      designatedPublicKey: first.witness[1]!, outpoint })).toBe(result.senderPaymentCode);
    expect(result.senderPaymentCode).toBe(paymentCodeFromAccount(deriveBip47Account(MNEMONIC)));
    let inputSum = 0n;
    for (let index = 0; index < tx.ins.length; index++) {
      const input = tx.ins[index]!;
      const original = params.utxos[index]!;
      expect(hex.encode(input.hash.slice().reverse())).toBe(original.txid);
      expect(input.index).toBe(original.vout);
      expect(input.witness).toHaveLength(2);
      const pubkey = input.witness[1]!;
      const signature = input.witness[0]!;
      const sighash = signature[signature.length - 1]!;
      expect(sighash).toBe(1);
      const message = tx.hashForWitnessV0(index, p2pkh(pubkey).script, original.valueSats, sighash);
      expect(secp256k1.verify(secp256k1.Signature.fromDER(signature.slice(0, -1)), message, pubkey)).toBe(true);
      inputSum += original.valueSats;
    }
    expect(result.feeSats).toBe(inputSum - tx.outs.reduce((sum, output) => sum + output.value, 0n));
    expect(result.feeSats >= BigInt(Math.ceil(result.vsize * params.feeRateSatPerVb))).toBe(true);
    expect(Transaction.fromRaw(hex.decode(result.txHex), { allowUnknownOutputs: true }).isFinal).toBe(true);
  });

  test.each([0.5, 1, 1.5, 10])("covers requested fee rate %s sat/vB", (feeRateSatPerVb) => {
    const result = buildBip47Notification({ ...setup(), feeRateSatPerVb });
    expect(result.feeSats >= BigInt(Math.ceil(result.vsize * feeRateSatPerVb))).toBe(true);
    expect(result.feeSats <= BigInt(Math.ceil((result.vsize + 1) * feeRateSatPerVb))).toBe(true);
  });

  test("drops dust change while preserving the notification and sufficient fee", () => {
    const result = buildBip47Notification(setup([1_000n]));
    const tx = BitcoinTransaction.fromHex(result.txHex);
    expect(tx.outs).toHaveLength(2);
    expect(result.changeVouts).toEqual([]);
    expect(result.changeSats).toBe(0n);
    expect(result.feeSats).toBe(454n);
    expect(result.feeSats >= BigInt(result.vsize)).toBe(true);
  });

  test("rejects missing funds, invalid amounts, duplicates and malformed outpoints", () => {
    expect(() => buildBip47Notification(setup([700n]))).toThrow(/insufficient/);
    expect(() => buildBip47Notification({ ...setup(), utxos: [] })).toThrow(/no UTXOs/);
    for (const rate of [0, -1, NaN, Infinity]) expect(() => buildBip47Notification({ ...setup(), feeRateSatPerVb: rate })).toThrow(/fee rate/);
    for (const value of [0n, 545n, 21_000_001n * 100_000_000n]) expect(() => buildBip47Notification({ ...setup(), notificationValueSats: value })).toThrow(/notification value/);
    const params = setup();
    expect(() => buildBip47Notification({ ...params, utxos: [params.utxos[0]!, params.utxos[0]!] })).toThrow(/duplicate/);
    expect(() => buildBip47Notification({ ...params, utxos: [{ ...params.utxos[0]!, vout: -1 }] })).toThrow(/outpoint/);
    expect(() => buildBip47Notification({ ...params, utxos: [{ ...params.utxos[0]!, valueSats: 0n }] })).toThrow(/input value/);
  });

  test("rejects foreign coins, forged watch metadata, foreign change and unsupported wallets", () => {
    const params = setup();
    expect(() => buildBip47Notification({ ...params, recipientPaymentCode: paymentCodeFromAccount(deriveBip47Account(MNEMONIC)) }))
      .toThrow(/self-notification/);
    expect(() => buildBip47Notification({ ...params, changeAddress: "1JDdmqFLhpzcUwPeinhJbUPw4Co3aWLyzW" })).toThrow(/change address/);
    const foreign = deriveWatchWallet(BOB_MNEMONIC, 1);
    expect(() => buildBip47Notification({ ...params, utxos: [{ ...params.utxos[0]!, scriptPubKey: foreign.addresses[0]!.scriptPubKey }] })).toThrow(/owned/);
    const forgedWallet = { ...params.wallet, addresses: params.wallet.addresses.map((entry, index) => index ? entry : ({ ...entry, path: "m/84'/0'/0'/0/1" })) };
    expect(() => buildBip47Notification({ ...params, wallet: forgedWallet })).toThrow(/does not match/);
    expect(() => buildBip47Notification({ ...params, secret: "1JDdmqFLhpzcUwPeinhJbUPw4Co3aWLyzW" })).toThrow(/mnemonic/);
    expect(() => buildBip47Notification({ ...params, recipientPaymentCode: "invalid" })).toThrow(/payment code/);
  });
});
