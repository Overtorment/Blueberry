import { describe, expect, test } from "bun:test";
import { Transaction } from "bitcoinjs-lib";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import { usedWatchIndexes } from "../../src/parse/used-indexes.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("usedWatchIndexes", () => {
  test("detects external receive and internal change", () => {
    const wallet = deriveWatchWallet(MNEMONIC, { external: 5, internal: 5 });
    const ext = wallet.addresses.find((a) => !a.change && a.index === 2)!;
    const int = wallet.addresses.find((a) => a.change && a.index === 1)!;

    const receive = new Transaction();
    receive.version = 2;
    receive.addInput(Buffer.alloc(32), 0xffffffff);
    receive.addOutput(ext.scriptPubKey, 1000n);

    const change = new Transaction();
    change.version = 2;
    change.addInput(Buffer.alloc(32), 0xffffffff);
    change.addOutput(int.scriptPubKey, 500n);

    const used = usedWatchIndexes(
      [{ tx: receive.toBuffer() }, { tx: change.toBuffer() }],
      wallet,
    );
    expect(used.external).toEqual([2]);
    expect(used.internal).toEqual([1]);
  });

  test("detects P2WPKH spend via witness", () => {
    const wallet = deriveWatchWallet(MNEMONIC, { external: 3, internal: 1 });
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
    const pubkey = root.derive("m/84'/0'/0'/0/2").publicKey!;

    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(new Uint8Array(32).fill(1), 0);
    spend.setWitness(0, [new Uint8Array(64), new Uint8Array(pubkey)]);
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 1n);

    const used = usedWatchIndexes([{ tx: spend.toBuffer() }], wallet);
    expect(used.external).toEqual([2]);
  });

  test("detects spend via prevout in same batch without witness", () => {
    const wallet = deriveWatchWallet(MNEMONIC, { external: 3, internal: 1 });
    const ext = wallet.addresses.find((a) => !a.change && a.index === 2)!;

    const receive = new Transaction();
    receive.version = 2;
    receive.addInput(Buffer.alloc(32), 0xffffffff);
    receive.addOutput(ext.scriptPubKey, 1000n);

    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(
      new Uint8Array(Buffer.from(receive.getId(), "hex").reverse()),
      0,
    );
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 900n);

    const used = usedWatchIndexes(
      [{ tx: receive.toBuffer() }, { tx: spend.toBuffer() }],
      wallet,
    );
    expect(used.external).toEqual([2]);
  });
});
