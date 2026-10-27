import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha2";
import { base58check, hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { p2pkh } from "@scure/btc-signer";
import {
  blindPaymentCode,
  decodePaymentCode,
  deriveBip47Account,
  deriveBip47ReceivePayment,
  deriveBip47SendPayment,
  encodePaymentCode,
  isPaymentCode,
  notificationAddress,
  notificationBlindingMask,
  notificationPublicKey,
  paymentCodeFromAccount,
  paymentCodePayload,
  serializeBip47Outpoint,
  unblindPaymentCode,
} from "../../src/wallet/bip47.ts";

// Interoperability fixtures linked from BIP47's Test Vectors section:
// https://gist.github.com/SamouraiDev/6aad669604c5930864bd
const ALICE_MNEMONIC = "response seminar brave tip suit recall often sound stick owner lottery motion";
const BOB_MNEMONIC = "reward upper indicate eight swift arch injury crystal super wrestle already dentist";
const ALICE_CODE = "PM8TJTLJbPRGxSbc8EJi42Wrr6QbNSaSSVJ5Y3E4pbCYiTHUskHg13935Ubb7q8tx9GVbh2UuRnBc3WSyJHhUrw8KhprKnn9eDznYGieTzFcwQRya4GA";
const BOB_CODE = "PM8TJS2JxQ5ztXUpBBRnpTbcUXbUHy2T1abfrb3KkAAtMEGNbey4oumH7Hc578WgQJhPjBxteQ5GHHToTYHE3A1w6p7tU6KSoFmWBVbFGjKPisZDbP97";
const ALICE_PAYLOAD = "010002b85034fb08a8bfefd22848238257b252721454bbbfba2c3667f168837ea2cdad671af9f65904632e2dcc0c6ad314e11d53fc82fa4c4ea27a4a14eccecc478fee00000000000000000000000000";
const BLINDED_PAYLOAD = "010002063e4eb95e62791b06c50e1a3a942e1ecaaa9afbbeb324d16ae6821e091611fa96c0cf048f607fe51a0327f5e2528979311c78cb2de0d682c61e1180fc3d543b00000000000000000000000000";
const OUTPOINT = hex.decode("86f411ab1c8e70ae8a0795ab7a6757aea6e4d5ae1826fc7b8f00c597d500609c01000000");
const DESIGNATED_WIF = "Kx983SRhAZpAhj7Aac1wUXMJ6XZeyJKqCxJJ49dxEbYCT4a1ozRD";
const DESIGNATED_PRIVATE = base58check(sha256).decode(DESIGNATED_WIF).slice(1, 33);
const ADDRESSES = [
  "141fi7TY3h936vRUKh1qfUZr8rSBuYbVBK", "12u3Uued2fuko2nY4SoSFGCoGLCBUGPkk6",
  "1FsBVhT5dQutGwaPePTYMe5qvYqqjxyftc", "1CZAmrbKL6fJ7wUxb99aETwXhcGeG3CpeA",
  "1KQvRShk6NqPfpr4Ehd53XUhpemBXtJPTL", "1KsLV2F47JAe6f8RtwzfqhjVa8mZEnTM7t",
  "1DdK9TknVwvBrJe7urqFmaxEtGF2TMWxzD", "16DpovNuhQJH7JUSZQFLBQgQYS4QB9Wy8e",
  "17qK2RPGZMDcci2BLQ6Ry2PDGJErrNojT5", "1GxfdfP286uE24qLZ9YRP3EWk2urqXgC4s",
];
const alice = deriveBip47Account(ALICE_MNEMONIC);
const bob = deriveBip47Account(BOB_MNEMONIC);

describe("BIP47 official interoperability vectors", () => {
  test("derives identity codes and notification keys from BIP39 seeds", () => {
    expect(paymentCodeFromAccount(alice)).toBe(ALICE_CODE);
    expect(paymentCodeFromAccount(bob)).toBe(BOB_CODE);
    expect(hex.encode(alice.deriveChild(0).privateKey!)).toBe("8d6a8ecd8ee5e0042ad0cb56e3a971c760b5145c3917a8e7beaf0ed92d7a520c");
    expect(hex.encode(notificationPublicKey(BOB_CODE))).toBe("024ce8e3b04ea205ff49f529950616c3db615b1e37753858cc60c1ce64d17e2ad8");
    expect(notificationAddress(ALICE_CODE)).toBe("1JDdmqFLhpzcUwPeinhJbUPw4Co3aWLyzW");
    expect(notificationAddress(BOB_CODE)).toBe("1ChvUUvht2hUQufHBXF8NgLhW8SwE2ecGV");
    expect(hex.encode(paymentCodePayload(decodePaymentCode(ALICE_CODE)))).toBe(ALICE_PAYLOAD);
  });

  test("reproduces the notification mask and blinded payload", () => {
    expect(hex.encode(notificationBlindingMask(DESIGNATED_PRIVATE, notificationPublicKey(BOB_CODE), OUTPOINT)))
      .toBe("be6e7a4256cac6f4d4ed4639b8c39c4cb8bece40010908e70d17ea9d77b4dc57f1da36f2d6641ccb37cf2b9f3146686462e0fa3161ae74f88c0afd4e307adbd5");
    const payload = blindPaymentCode({
      paymentCode: ALICE_CODE, designatedPrivateKey: DESIGNATED_PRIVATE,
      recipientPaymentCode: BOB_CODE, outpoint: OUTPOINT,
    });
    expect(hex.encode(payload)).toBe(BLINDED_PAYLOAD);
    expect(unblindPaymentCode({ payload, recipientAccount: bob,
      designatedPublicKey: secp256k1.getPublicKey(DESIGNATED_PRIVATE, true), outpoint: OUTPOINT,
    })).toBe(ALICE_CODE);
  });

  test.each(ADDRESSES.map((address, index) => [index, address] as const))(
    "sender and recipient derive vector %i and the recipient controls it", (index, address) => {
      const send = deriveBip47SendPayment(alice, BOB_CODE, index);
      const receive = deriveBip47ReceivePayment(bob, ALICE_CODE, index);
      expect(send.index).toBe(index);
      expect(send.address).toBe(address);
      expect(receive.address).toBe(address);
      expect(send.publicKey).toEqual(receive.publicKey);
      expect(send.scriptPubKey).toEqual(receive.scriptPubKey);
      expect(p2pkh(secp256k1.getPublicKey(receive.privateKey)).address).toBe(address);
      const message = sha256(new TextEncoder().encode("BIP47 receive key proof"));
      expect(secp256k1.verify(secp256k1.sign(message, receive.privateKey), message, send.publicKey)).toBe(true);
    },
  );
});

describe("BIP47 validation and boundary behavior", () => {
  test("round trips public account keys without requiring a private key", () => {
    expect(encodePaymentCode(decodePaymentCode(ALICE_CODE))).toBe(ALICE_CODE);
    const publicOnly = HDKey.fromExtendedKey(alice.publicExtendedKey);
    expect(paymentCodeFromAccount(publicOnly)).toBe(ALICE_CODE);
    expect(isPaymentCode(ALICE_CODE)).toBe(true);
    expect(isPaymentCode("not a payment code")).toBe(false);
  });

  test("rejects malformed codes, incorrect versions, flags, padding and curve points", () => {
    const codec = base58check(sha256);
    const valid = codec.decode(ALICE_CODE);
    const mutate = (index: number, value: number) => {
      const bytes = valid.slice(); bytes[index] = value; return codec.encode(bytes);
    };
    for (const bad of ["", "P".repeat(121), ALICE_CODE.slice(0, -1) + "1", codec.encode(valid.slice(1)),
      mutate(0, 0x48), mutate(1, 2), mutate(2, 1), mutate(3, 4), mutate(68, 1)]) {
      expect(() => decodePaymentCode(bad)).toThrow();
      expect(isPaymentCode(bad)).toBe(false);
    }
    const invalidPoint = valid.slice(); invalidPoint.fill(0xff, 4, 36);
    expect(() => decodePaymentCode(codec.encode(invalidPoint))).toThrow();
    expect(() => encodePaymentCode({ ...decodePaymentCode(ALICE_CODE), chainCode: new Uint8Array(31) })).toThrow();
  });

  test("rejects wrong wallet kinds and unsupported indexes", () => {
    expect(() => deriveBip47Account("not a mnemonic")).toThrow(/mnemonic/);
    for (const index of [-1, 0.1, NaN, Infinity, 0x80000000, Number.MAX_SAFE_INTEGER]) {
      expect(() => deriveBip47Account(ALICE_MNEMONIC, index)).toThrow(/index/);
      expect(() => deriveBip47SendPayment(alice, BOB_CODE, index)).toThrow(/index/);
      expect(() => deriveBip47ReceivePayment(bob, ALICE_CODE, index)).toThrow(/index/);
    }
    expect(() => paymentCodeFromAccount(alice.deriveChild(0))).toThrow(/account-level/);
    expect(paymentCodeFromAccount(deriveBip47Account(ALICE_MNEMONIC, 1))).not.toBe(ALICE_CODE);
    const publicOnly = HDKey.fromExtendedKey(alice.publicExtendedKey);
    expect(() => deriveBip47SendPayment(publicOnly, BOB_CODE, 0)).toThrow(/private account/);
    expect(() => deriveBip47ReceivePayment(publicOnly, BOB_CODE, 0)).toThrow(/private account/);
  });

  test("validates notification inputs and preserves its arguments", () => {
    const payload = hex.decode(BLINDED_PAYLOAD);
    const savedPayload = payload.slice();
    const outpoint = OUTPOINT.slice();
    unblindPaymentCode({ payload, recipientAccount: bob, designatedPublicKey: secp256k1.getPublicKey(DESIGNATED_PRIVATE), outpoint });
    expect(payload).toEqual(savedPayload);
    expect(hex.encode(outpoint)).toBe(hex.encode(OUTPOINT));
    expect(() => notificationBlindingMask(DESIGNATED_PRIVATE, notificationPublicKey(BOB_CODE), new Uint8Array(35))).toThrow(/outpoint/);
    expect(() => notificationBlindingMask(new Uint8Array(32), notificationPublicKey(BOB_CODE), outpoint)).toThrow(/private key/);
    expect(() => notificationBlindingMask(DESIGNATED_PRIVATE, new Uint8Array(33), outpoint)).toThrow(/public key/);
    expect(() => unblindPaymentCode({ payload: payload.slice(1), recipientAccount: bob,
      designatedPublicKey: secp256k1.getPublicKey(DESIGNATED_PRIVATE), outpoint })).toThrow(/80 bytes/);
    expect(() => unblindPaymentCode({ payload, recipientAccount: HDKey.fromExtendedKey(bob.publicExtendedKey),
      designatedPublicKey: secp256k1.getPublicKey(DESIGNATED_PRIVATE), outpoint })).toThrow(/private account/);
  });

  test("serializes displayed transaction IDs and output indexes in Bitcoin wire order", () => {
    const displayedTxid = hex.encode(OUTPOINT.slice(0, 32).reverse());
    expect(serializeBip47Outpoint(displayedTxid, 1)).toEqual(OUTPOINT);
    expect(hex.encode(serializeBip47Outpoint("12".repeat(32), 0xffffffff)).slice(-8)).toBe("ffffffff");
    for (const index of [-1, 1.5, NaN, 0x100000000]) {
      expect(() => serializeBip47Outpoint(displayedTxid, index)).toThrow(/index/);
    }
    expect(() => serializeBip47Outpoint("aa", 0)).toThrow(/txid/);
  });

  test("different channel directions and indexes cannot reuse the same destination", () => {
    const forwards = deriveBip47SendPayment(alice, BOB_CODE, 0);
    expect(deriveBip47SendPayment(bob, ALICE_CODE, 0).address).not.toBe(forwards.address);
    expect(deriveBip47SendPayment(alice, BOB_CODE, 1).address).not.toBe(forwards.address);
  });
});
