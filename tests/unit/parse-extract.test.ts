import { describe, expect, test } from "bun:test";
import { Block, Transaction } from "bitcoinjs-lib";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { extractWatchTxs, outpointKey } from "../../src/parse/extract.ts";
import type { WatchUtxo } from "../../src/parse/types.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function watchScript0(): { script: Uint8Array; pubkey: Uint8Array } {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const child = root.derive("m/84'/0'/0'/0/0");
  const pubkey = child.publicKey!;
  const { script } = p2wpkh(pubkey);
  return { script: new Uint8Array(script), pubkey: new Uint8Array(pubkey) };
}

function wrapBlock(txs: Transaction[]): Block {
  const block = new Block();
  block.version = 1;
  block.prevHash = new Uint8Array(32);
  block.merkleRoot = Block.calculateMerkleRoot(txs);
  block.timestamp = 0;
  block.bits = 0;
  block.nonce = 0;
  block.transactions = txs;
  return block;
}

describe("extractWatchTxs", () => {
  test("keeps receive; ignores unrelated; detects witness spend and prior-utxo spend", () => {
    const { script, pubkey } = watchScript0();

    const receive = new Transaction();
    receive.version = 2;
    receive.addInput(Buffer.alloc(32), 0xffffffff);
    receive.addOutput(script, 1000n);

    const unrelated = new Transaction();
    unrelated.version = 2;
    unrelated.addInput(Buffer.alloc(32), 0xffffffff);
    unrelated.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 500n);

    const foundReceive = extractWatchTxs(
      wrapBlock([receive, unrelated]),
      [script],
      new Map(),
    );
    expect(foundReceive.map((t) => t.txid)).toEqual([receive.getId()]);

    // Spend via witness pubkey, no prior UTXO knowledge
    const witnessSpend = new Transaction();
    witnessSpend.version = 2;
    witnessSpend.addInput(new Uint8Array(32).fill(1), 0);
    witnessSpend.setWitness(0, [new Uint8Array(64), pubkey]);
    witnessSpend.addOutput(
      new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]),
      900n,
    );
    expect(
      extractWatchTxs(wrapBlock([witnessSpend]), [script], new Map()),
    ).toHaveLength(1);

    // Spend via known prior UTXO (no useful witness)
    const prior = new Map<string, WatchUtxo>([
      [
        outpointKey(receive.getId(), 0),
        { value: 1000n, scriptPubKey: script },
      ],
    ]);
    const knownSpend = new Transaction();
    knownSpend.version = 2;
    knownSpend.addInput(
      new Uint8Array(Buffer.from(receive.getId(), "hex").reverse()),
      0,
    );
    knownSpend.addOutput(
      new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]),
      900n,
    );
    const foundSpend = extractWatchTxs(
      wrapBlock([knownSpend]),
      [script],
      prior,
    );
    expect(foundSpend).toHaveLength(1);
    expect(prior.has(outpointKey(receive.getId(), 0))).toBe(false);
  });
});
