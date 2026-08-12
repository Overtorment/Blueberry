import { describe, expect, test } from "bun:test";
import { Block, script as bscript, Transaction } from "bitcoinjs-lib";
import { p2pkh, p2sh, p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { extractWatchTxs, outpointKey } from "../../src/parse/extract.ts";
import type { WatchUtxo } from "../../src/parse/types.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function watchKey0(): Uint8Array {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  return new Uint8Array(root.derive("m/84'/0'/0'/0/0").publicKey!);
}

function watchScript0(): { script: Uint8Array; pubkey: Uint8Array } {
  const pubkey = watchKey0();
  const { script } = p2wpkh(pubkey);
  return { script: new Uint8Array(script), pubkey };
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

  test("detects P2PKH spend from scriptSig without prior UTXO", () => {
    const pubkey = watchKey0();
    const { script } = p2pkh(pubkey);
    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(new Uint8Array(32).fill(1), 0);
    spend.setInputScript(
      0,
      bscript.compile([Buffer.alloc(71, 2), Buffer.from(pubkey)]),
    );
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 900n);
    expect(
      extractWatchTxs(
        wrapBlock([spend]),
        [new Uint8Array(script)],
        new Map(),
      ),
    ).toHaveLength(1);
  });

  test("detects P2SH-P2WPKH spend from witness without prior UTXO", () => {
    const pubkey = watchKey0();
    const { script } = p2sh(p2wpkh(pubkey));
    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(new Uint8Array(32).fill(1), 0);
    spend.setWitness(0, [new Uint8Array(64), pubkey]);
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 900n);
    expect(
      extractWatchTxs(
        wrapBlock([spend]),
        [new Uint8Array(script)],
        new Map(),
      ),
    ).toHaveLength(1);
  });

  test("ignores spends unlocked by an unrelated pubkey", () => {
    const watched = p2pkh(watchKey0()).script!;
    const other = new Uint8Array(33).fill(3);
    other[0] = 0x02;
    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(new Uint8Array(32).fill(1), 0);
    spend.setInputScript(
      0,
      bscript.compile([Buffer.alloc(71, 2), Buffer.from(other)]),
    );
    spend.setWitness(0, [new Uint8Array(64), other]);
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 900n);
    expect(
      extractWatchTxs(wrapBlock([spend]), [new Uint8Array(watched)], new Map()),
    ).toHaveLength(0);
  });
});
