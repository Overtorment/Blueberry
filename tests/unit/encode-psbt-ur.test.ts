import { describe, expect, test } from "bun:test";
import { URDecoder } from "@ngraveio/bc-ur";
import { CryptoPSBT } from "@keystonehq/bc-ur-registry";
import { buildUnsignedSendPsbt } from "../../src/wallet/build-send-tx.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import {
  BC_UR_PSBT_CAPACITY,
  encodeCryptoPsbtUrFragments,
} from "../../src/wallet/encode-psbt-ur.ts";

const BLUE_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

describe("encodeCryptoPsbtUrFragments (BlueWallet URv2)", () => {
  test("encodes unsigned PSBT as ur:crypto-psbt parts that round-trip", () => {
    const wallet = deriveWatchWallet(BLUE_ZPUB, { external: 2, internal: 1 });
    const recv = wallet.addresses.find((a) => !a.change)!;
    const dest = wallet.addresses.find((a) => !a.change && a.index === 1)!;
    const change = wallet.addresses.find((a) => a.change)!;
    const { psbtHex } = buildUnsignedSendPsbt({
      secret: BLUE_ZPUB,
      wallet,
      utxos: [
        {
          txid: "11".repeat(32),
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: recv.scriptPubKey,
        },
      ],
      toAddress: dest.address,
      amountSats: 50_000n,
      feeRateSatPerVb: 10,
      changeAddress: change.address,
    });

    const parts = encodeCryptoPsbtUrFragments(psbtHex, BC_UR_PSBT_CAPACITY);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.toLowerCase().startsWith("ur:crypto-psbt/")).toBe(true);
    }

    const decoder = new URDecoder();
    for (const part of parts) decoder.receivePart(part);
    expect(decoder.isComplete()).toBe(true);
    expect(decoder.isSuccess()).toBe(true);
    const ur = decoder.resultUR();
    expect(ur.type).toBe("crypto-psbt");
    const decoded = CryptoPSBT.fromCBOR(ur.cbor);
    expect(decoded.getPSBT().toString("hex")).toBe(psbtHex);
  });
});
