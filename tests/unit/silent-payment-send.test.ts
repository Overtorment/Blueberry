import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "@scure/btc-signer";
import { taprootTweakPrivKey } from "@scure/btc-signer/utils";
import { buildSend, buildUnsignedSendPsbt, type BuildSendTxParams } from "../../src/wallet/build-send-tx.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import { isAddressValid } from "../../src/wallet/is-address-valid.ts";
import { isPaymentDestinationValid } from "../../src/wallet/payment-destination.ts";
import { deriveSilentPaymentKeys, scanSilentPaymentOutputs, silentPaymentSpendPrivateKey } from "../../src/wallet/silent-payments.ts";
import { decodeWif } from "../../src/wallet/secret.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT = deriveSilentPaymentKeys("legal winner thank year wave sausage worth useful legal winner thank yellow");
const WIF = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";

function fixture(): BuildSendTxParams {
  const wallet = deriveWatchWallet(MNEMONIC, 2);
  return {
    secret: MNEMONIC, wallet,
    utxos: [{ txid: "11".repeat(32), vout: 0, valueSats: 100_000n, scriptPubKey: wallet.addresses[0]!.scriptPubKey }],
    toAddress: RECIPIENT.address, amountSats: 25_000n, feeRateSatPerVb: 1.5,
    changeAddress: wallet.addresses.find((address) => address.change)!.address,
  };
}

describe("Silent Payments wallet sending", () => {
  test("send destinations accept SP without treating them as fixed watch addresses", () => {
    expect(isPaymentDestinationValid(RECIPIENT.address)).toBe(true);
    expect(isPaymentDestinationValid(` ${RECIPIENT.address.toUpperCase()} `)).toBe(true);
    expect(isAddressValid(RECIPIENT.address)).toBe(false);
    expect(isPaymentDestinationValid(RECIPIENT.address.slice(0, -1) + "!点")).toBe(false);
  });

  test("signed transaction is detectable and spendable by recipient, with correct change and fee", () => {
    const params = fixture();
    const result = buildSend(params);
    if (result.kind !== "signed") throw new Error("expected signed send");
    expect(result.resolvedToAddress).toMatch(/^bc1p/);
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    const inputPublicKey = root.derive(params.wallet.addresses[0]!.path).publicKey!;
    const outputs = Array.from({ length: tx.outputsLength }, (_, index) => tx.getOutput(index));
    const destination = outputs.find((output) => output.script?.[0] === 0x51)!;
    const matches = scanSilentPaymentOutputs({
      inputs: params.utxos, inputPublicKeys: [inputPublicKey], outputPublicKeys: [destination.script!.slice(2)],
      scanPrivateKey: RECIPIENT.scanPrivateKey, spendPublicKey: RECIPIENT.spendPublicKey,
    });
    expect(matches).toHaveLength(1);
    const spendKey = silentPaymentSpendPrivateKey(RECIPIENT.spendPrivateKey, matches[0]!.privateKeyTweak);
    expect(secp256k1.getPublicKey(spendKey, true).slice(1)).toEqual(destination.script!.slice(2));
    expect(destination.amount).toBe(params.amountSats as bigint);
    expect(result.feeSats).toBe(BigInt(Math.ceil(result.vsize * params.feeRateSatPerVb)));
    expect(result.changeVouts).toHaveLength(1);
    expect(tx.getOutputAddress(result.changeVouts[0]!)).toBe(params.changeAddress);
    expect(result.changeSats + result.feeSats + (params.amountSats as bigint)).toBe(100_000n);
    expect(tx.isFinal).toBe(true);
  });

  test("max spends have one detectable destination and no change", () => {
    const result = buildSend({ ...fixture(), amountSats: "max", changeAddress: RECIPIENT.address });
    if (result.kind !== "signed") throw new Error("expected signed send");
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutputAddress(0)).toBe(result.resolvedToAddress!);
    expect(tx.getOutput(0).amount! + result.feeSats).toBe(100_000n);
    expect(result.changeSats).toBe(0n);
    expect(result.changeVouts).toEqual([]);
  });

  test("commits to every selected input and its outpoint", () => {
    const params = fixture();
    const first = buildSend(params);
    const second = buildSend({ ...params, utxos: [...params.utxos, { ...params.utxos[0]!, txid: "22".repeat(32) }] });
    const changed = buildSend({ ...params, utxos: [{ ...params.utxos[0]!, vout: 1 }] });
    if (first.kind !== "signed" || second.kind !== "signed" || changed.kind !== "signed") throw new Error("expected signed send");
    expect(first.resolvedToAddress).not.toBe(second.resolvedToAddress);
    expect(first.resolvedToAddress).not.toBe(changed.resolvedToAddress);
    expect(Transaction.fromRaw(hex.decode(second.txHex)).inputsLength).toBe(2);
  });

  test("rejects duplicate outpoints and a mismatched mnemonic", () => {
    const params = fixture();
    expect(() => buildSend({ ...params, utxos: [...params.utxos, ...params.utxos] })).toThrow("duplicate");
    expect(() => buildSend({ ...params, secret: "legal winner thank year wave sausage worth useful legal winner thank yellow" }))
      .toThrow("does not match its private key");
  });

  test("watch-only and externally mutable PSBT inputs cannot send SP", () => {
    const params = fixture();
    expect(() => buildUnsignedSendPsbt(params)).toThrow("PSBT export is unsupported");
    const secret = params.wallet.addresses[0]!.address;
    const wallet = deriveWatchWallet(secret);
    expect(() => buildSend({ ...params, secret, wallet })).toThrow("PSBT export is unsupported");
  });

  test("compressed WIF Taproot uses the tweaked even-Y output key", () => {
    const wallet = deriveWatchWallet(WIF);
    const watched = wallet.addresses.find((address) => address.scriptType === "p2tr")!;
    const params = { ...fixture(), secret: WIF, wallet,
      utxos: [{ txid: "33".repeat(32), vout: 0, valueSats: 100_000n, scriptPubKey: watched.scriptPubKey }],
      changeAddress: watched.address };
    const result = buildSend(params);
    if (result.kind !== "signed") throw new Error("expected signed send");
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    const publicKey = secp256k1.getPublicKey(taprootTweakPrivKey(decodeWif(WIF).privateKey), true);
    publicKey[0] = 2;
    const destination = Array.from({ length: tx.outputsLength }, (_, index) => tx.getOutput(index))
      .find((output) => output.amount === params.amountSats)!;
    expect(scanSilentPaymentOutputs({ inputs: params.utxos, inputPublicKeys: [publicKey],
      outputPublicKeys: [destination.script!.slice(2)], scanPrivateKey: RECIPIENT.scanPrivateKey,
      spendPublicKey: RECIPIENT.spendPublicKey })).toHaveLength(1);
  });
});
