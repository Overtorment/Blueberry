import { describe, expect, test } from "bun:test";
import { buildUnsignedSendPsbt } from "../../src/wallet/build-send-tx.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import { encodeCryptoPsbtUrFragments } from "../../src/wallet/encode-psbt-ur.ts";
import { fitCryptoPsbtUrQr } from "../../src/tui/fit-ur-qr.ts";
import { qrCompactSize } from "../../src/tui/qr-ascii.ts";

const BLUE_ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

function samplePsbtHex(): string {
  const wallet = deriveWatchWallet(BLUE_ZPUB, { external: 2, internal: 1 });
  const recv = wallet.addresses.find((a) => !a.change)!;
  const dest = wallet.addresses.find((a) => !a.change && a.index === 1)!;
  const change = wallet.addresses.find((a) => a.change)!;
  return buildUnsignedSendPsbt({
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
  }).psbtHex;
}

describe("fitCryptoPsbtUrQr", () => {
  test("tight budget uses smaller capacity than a roomy one", () => {
    const psbtHex = samplePsbtHex();
    const roomy = fitCryptoPsbtUrQr(psbtHex, 120, 40);
    const tight = fitCryptoPsbtUrQr(psbtHex, 55, 22);
    expect(tight.capacity).toBeLessThan(roomy.capacity);
    for (const part of tight.parts) {
      const { width, height } = qrCompactSize(part);
      expect(width).toBeLessThanOrEqual(55);
      expect(height).toBeLessThanOrEqual(22);
    }
  });

  test("impossible budget falls back to smallest capacity encode", () => {
    const psbtHex = samplePsbtHex();
    const tiny = fitCryptoPsbtUrQr(psbtHex, 8, 4);
    const minParts = encodeCryptoPsbtUrFragments(psbtHex, 10);
    expect(tiny.capacity).toBe(10);
    expect(tiny.parts.length).toBe(minParts.length);
    // Still oversized vs budget — caller must accept least-bad QR.
    const { width, height } = qrCompactSize(tiny.parts[0]!);
    expect(width > 8 || height > 4).toBe(true);
  });
});
