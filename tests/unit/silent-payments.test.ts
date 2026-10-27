import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { secp256k1, schnorr } from "@noble/curves/secp256k1";
import { bech32, bech32m, hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  decodeSilentPaymentAddress, deriveSilentPaymentKeys, deriveSilentPaymentOutputs,
  encodeSilentPaymentAddress, encodeLabeledSilentPaymentAddress,
  isSilentPaymentAddress, scanSilentPaymentOutputs, silentPaymentSpendPrivateKey,
  type SilentPaymentSenderInput,
} from "../../src/wallet/silent-payments.ts";

type Vin = { txid: string; vout: number; private_key?: string; prevout: { scriptPubKey: { hex: string } } };
type Vector = {
  comment: string;
  sending: { given: { vin: Vin[]; recipients: { address: string }[] }; expected: {
    outputs: string[][]; input_pub_keys: string[];
  } }[];
  receiving: { given: { vin: Vin[]; outputs: string[]; key_material: {
    scan_priv_key: string; spend_priv_key: string;
  }; labels: number[] }; expected: { addresses: string[]; outputs: { priv_key_tweak: string; pub_key: string }[] } }[];
};
// Unmodified cases from bitcoin/bips BIP352, BSD-2-Clause. See fixture README.
const vectors: Vector[] = JSON.parse(readFileSync(new URL("../fixtures/bip352-send-receive.json", import.meta.url), "utf8"));

function senderInputs(vin: Vin[]): SilentPaymentSenderInput[] {
  return vin.map((input) => {
    const script = input.prevout.scriptPubKey.hex;
    const type = script.startsWith("5120") ? "p2tr" : script.startsWith("0014") ? "p2wpkh"
      : script.startsWith("76a914") ? "p2pkh" : script.startsWith("a914") ? "p2sh-p2wpkh" : "other";
    return { txid: input.txid, vout: input.vout, type,
      privateKey: input.private_key ? hex.decode(input.private_key) : undefined };
  });
}

describe("BIP352 official interoperability vectors", () => {
  for (const vector of vectors) {
    for (const [index, sending] of vector.sending.entries()) {
      test(`send: ${vector.comment} (${index})`, () => {
        const run = () => deriveSilentPaymentOutputs(senderInputs(sending.given.vin), sending.given.recipients.map((r) => r.address));
        if (vector.comment.startsWith("Input keys sum up to zero")) {
          expect(run).toThrow("sum to zero");
          return;
        }
        const outputs = run().map((o) => hex.encode(o.publicKey));
        // Official vectors allow output permutations within scan-key groups.
        expect(sending.expected.outputs.some((candidate) =>
          [...candidate].sort().join() === [...outputs].sort().join())).toBe(true);
      });
    }
    for (const [index, receiving] of vector.receiving.entries()) {
      test(`receive primitive: ${vector.comment} (${index})`, () => {
        const scanPrivateKey = hex.decode(receiving.given.key_material.scan_priv_key);
        const spendPrivateKey = hex.decode(receiving.given.key_material.spend_priv_key);
        const spendPublicKey = secp256k1.getPublicKey(spendPrivateKey, true);
        expect(encodeSilentPaymentAddress(secp256k1.getPublicKey(scanPrivateKey, true), spendPublicKey))
          .toBe(receiving.expected.addresses[0]!);
        receiving.given.labels.forEach((label, i) => {
          expect(encodeLabeledSilentPaymentAddress(scanPrivateKey, spendPublicKey, label))
            .toBe(receiving.expected.addresses[i + 1]!);
        });
        const matches = scanSilentPaymentOutputs({
          inputs: receiving.given.vin,
          inputPublicKeys: vector.sending[0]!.expected.input_pub_keys.map((key) => hex.decode(key)),
          outputPublicKeys: receiving.given.outputs.map((key) => hex.decode(key)),
          scanPrivateKey, spendPublicKey, labels: receiving.given.labels,
        });
        expect(matches.map((m) => hex.encode(m.publicKey)).sort())
          .toEqual(receiving.expected.outputs.map((m) => m.pub_key).sort());
        for (const match of matches) {
          const expected = receiving.expected.outputs.find((o) => o.pub_key === hex.encode(match.publicKey))!;
          expect(hex.encode(match.privateKeyTweak)).toBe(expected.priv_key_tweak);
          const key = silentPaymentSpendPrivateKey(spendPrivateKey, match.privateKeyTweak);
          expect(hex.encode(schnorr.getPublicKey(key))).toBe(expected.pub_key);
        }
      });
    }
  }
});

const PRIVATE_ONE = hex.decode("00".repeat(31) + "01");
const PRIVATE_TWO = hex.decode("00".repeat(31) + "02");
const PUBLIC_ONE = secp256k1.getPublicKey(PRIVATE_ONE, true);
const PUBLIC_TWO = secp256k1.getPublicKey(PRIVATE_TWO, true);
const ADDRESS = encodeSilentPaymentAddress(PUBLIC_ONE, PUBLIC_TWO);
const INPUT: SilentPaymentSenderInput = { txid: "01".repeat(32), vout: 0, type: "p2wpkh", privateKey: PRIVATE_ONE };

describe("Silent Payments validation and wallet derivation", () => {
  test("roundtrips mainnet addresses and accepts uppercase", () => {
    expect(ADDRESS.length).toBe(116);
    const parsed = decodeSilentPaymentAddress(ADDRESS.toUpperCase());
    expect(parsed.scanPublicKey).toEqual(PUBLIC_ONE);
    expect(parsed.spendPublicKey).toEqual(PUBLIC_TWO);
  });

  test("rejects mixed case, checksum, network, malformed keys, and wrong length", () => {
    const payload = [...PUBLIC_ONE, ...PUBLIC_TWO];
    const words = [0, ...bech32m.toWords(new Uint8Array(payload))];
    for (const value of [ADDRESS.slice(0, -1) + "q", "SP" + ADDRESS.slice(2),
      bech32m.encode("tsp", words, 1023), bech32.encode("sp", words, 1023),
      bech32m.encode("sp", [0, ...bech32m.toWords(new Uint8Array(66))], 1023),
      bech32m.encode("sp", [0, ...bech32m.toWords(new Uint8Array([...payload, 0]))], 1023)]) {
      expect(isSilentPaymentAddress(value)).toBe(false);
    }
  });

  test("handles future versions exactly as required by BIP352", () => {
    const data = new Uint8Array([...PUBLIC_ONE, ...PUBLIC_TWO, 123]);
    for (const version of [1, 16, 30]) {
      const address = bech32m.encode("sp", [version, ...bech32m.toWords(data)], 1023);
      expect(decodeSilentPaymentAddress(address).scanPublicKey).toEqual(PUBLIC_ONE);
    }
    expect(isSilentPaymentAddress(bech32m.encode("sp", [31, ...bech32m.toWords(data)], 1023))).toBe(false);
  });

  test("uses BIP352 hardened scan/spend branches", () => {
    const mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const derived = deriveSilentPaymentKeys(mnemonic);
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
    expect(derived.scanPrivateKey).toEqual(root.derive("m/352'/0'/0'/1'/0").privateKey!);
    expect(derived.spendPrivateKey).toEqual(root.derive("m/352'/0'/0'/0'/0").privateKey!);
    expect(derived.scanPrivateKey).not.toEqual(derived.spendPrivateKey);
    expect(() => deriveSilentPaymentKeys("bad mnemonic")).toThrow();
    expect(() => deriveSilentPaymentKeys(mnemonic, -1)).toThrow();
  });

  test("validates outpoints, duplicate inputs, and every eligible private key", () => {
    for (const input of [{ ...INPUT, txid: "bad" }, { ...INPUT, vout: -1 },
      { ...INPUT, vout: 1.5 }, { ...INPUT, vout: 2 ** 32 }, { ...INPUT, privateKey: undefined },
      { ...INPUT, privateKey: new Uint8Array(32) }]) {
      expect(() => deriveSilentPaymentOutputs([input], [ADDRESS])).toThrow();
    }
    expect(() => deriveSilentPaymentOutputs([INPUT, INPUT], [ADDRESS])).toThrow("duplicate");
    expect(() => deriveSilentPaymentOutputs([], [ADDRESS])).toThrow();
    expect(() => deriveSilentPaymentOutputs([{ ...INPUT, type: "other" }], [ADDRESS])).toThrow();
  });

  test("all outpoints contribute to uniqueness even for ineligible inputs", () => {
    const original = deriveSilentPaymentOutputs([INPUT], [ADDRESS])[0]!;
    const withOther = deriveSilentPaymentOutputs([INPUT,
      { txid: "00".repeat(32), vout: 0, type: "other" }], [ADDRESS])[0]!;
    expect(original.address).not.toBe(withOther.address);
    expect(hex.encode(original.scriptPubKey)).toBe("5120" + hex.encode(original.publicKey));
  });

  test("fails before deriving outputs above the per-scan-key group limit", () => {
    expect(() => deriveSilentPaymentOutputs([INPUT], Array(2324).fill(ADDRESS))).toThrow("too many");
  });

  test("checks change label zero even when caller supplies no labels", () => {
    const labeled = encodeLabeledSilentPaymentAddress(PRIVATE_ONE, PUBLIC_TWO, 0);
    const outputs = deriveSilentPaymentOutputs([INPUT], [labeled]);
    const matches = scanSilentPaymentOutputs({ inputs: [INPUT], inputPublicKeys: [PUBLIC_ONE],
      outputPublicKeys: outputs.map((o) => o.publicKey), scanPrivateKey: PRIVATE_ONE, spendPublicKey: PUBLIC_TWO });
    expect(matches.length).toBe(1);
    expect(matches[0]!.label).toBe(0);
  });

  test("stops at the first missing counter and uses cryptographic matches", () => {
    const outputs = deriveSilentPaymentOutputs([INPUT], [ADDRESS, ADDRESS, ADDRESS]);
    const scan = (keys: Uint8Array[]) => scanSilentPaymentOutputs({ inputs: [INPUT], inputPublicKeys: [PUBLIC_ONE],
      outputPublicKeys: keys, scanPrivateKey: PRIVATE_ONE, spendPublicKey: PUBLIC_TWO });
    expect(scan([outputs[1]!.publicKey, outputs[2]!.publicKey])).toHaveLength(0);
    expect(scan([outputs[0]!.publicKey, outputs[2]!.publicKey])).toHaveLength(1);
    expect(scan(outputs.map((o) => o.publicKey))).toHaveLength(3);
  });
});
