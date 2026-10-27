import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hex } from "@scure/base";
import { Block, Transaction, script as bitcoinScript } from "bitcoinjs-lib";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import type { Database } from "../../src/db/types.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../../src/modules/parse-blocks.ts";
import { activeBip47PaymentCode, buildActiveBip47Notification, buildActiveSendTx, setActiveSendContext, validateActivePaymentBroadcast } from "../../src/tui/send-context.ts";
import { snapshotFromDb } from "../../src/tui/wallet-txs-store.ts";
import { createBip47Channels } from "../../src/wallet/bip47-channels.ts";
import { BIP47_ENABLED_KEY, observeBip47Transactions } from "../../src/wallet/bip47-wallet.ts";
import { deriveBip47Account, deriveBip47SendPayment, paymentCodeFromAccount } from "../../src/wallet/bip47.ts";
import type { BuildSendResult, SendInputUtxo } from "../../src/wallet/build-send-tx.ts";
import { firstUnusedExternalAddress } from "../../src/wallet/receive-address.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

const ALICE_MNEMONIC = "response seminar brave tip suit recall often sound stick owner lottery motion";
const BOB_MNEMONIC = "reward upper indicate eight swift arch injury crystal super wrestle already dentist";
const DESTINATION = "1JDdmqFLhpzcUwPeinhJbUPw4Co3aWLyzW";
const ALICE_CODE = paymentCodeFromAccount(deriveBip47Account(ALICE_MNEMONIC));
const BOB_CODE = paymentCodeFromAccount(deriveBip47Account(BOB_MNEMONIC));

function signed(result: BuildSendResult) {
  if (result.kind !== "signed") throw new Error("expected signed transaction");
  return result;
}

function record(db: Database, tx: Transaction, height = 10, txIndex = 0): void {
  if (!db.headers.get(height)) {
    db.headers.append([{ height, hashInternalHex: "aa".repeat(32), header: new Uint8Array(80), cumulativeWork: BigInt(height) }]);
  }
  db.transactions.upsert({ txid: tx.getId(), height, txIndex, blockHashInternalHex: "aa".repeat(32),
    tx: tx.toBuffer(), netDeltaSats: 0 });
}

function fund(db: Database, wallet: ReturnType<typeof createWallet>, index: number, valueSats: bigint): SendInputUtxo {
  const address = wallet.snapshot().addresses.find((entry) => !entry.change && entry.index === index)!;
  const tx = new Transaction();
  tx.version = 2;
  tx.addInput(new Uint8Array(32).fill(index + 1), index);
  tx.addOutput(address.scriptPubKey, valueSats);
  record(db, tx, 10, index);
  return { txid: tx.getId(), vout: 0, valueSats, scriptPubKey: address.scriptPubKey };
}

function blockWith(txs: Transaction[]): Uint8Array {
  const block = new Block();
  block.version = 1;
  block.prevHash = new Uint8Array(32);
  block.merkleRoot = Block.calculateMerkleRoot(txs);
  block.timestamp = 0;
  block.bits = 0;
  block.nonce = 0;
  block.transactions = txs;
  return block.toBuffer();
}

async function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("BIP47 wallet flow timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("BIP47 wallet lifecycle", () => {
  test("establishes a channel, reparses a same-block payment, excludes notification value and spends the received key", async () => {
    const aliceDb = createSqliteDatabase(":memory:");
    const bobDb = createSqliteDatabase(":memory:");
    const alice = createWallet(aliceDb, { secret: ALICE_MNEMONIC, addressGap: 3 });
    const bob = createWallet(bobDb, { secret: BOB_MNEMONIC, addressGap: 3 });
    const notificationCoin = fund(aliceDb, alice, 0, 50_000n);
    const paymentCoin = fund(aliceDb, alice, 1, 100_000n);
    const bus = createMessageBus();
    const mod = createParseBlocksModule({ bus, db: bobDb }, { wallet: bob, idleDelayMs: 20, blockGapMs: 0 });
    try {
      setActiveSendContext(bobDb, bob);
      expect(activeBip47PaymentCode()).toBe(BOB_CODE);
      expect(bob.snapshot().addresses.some((entry) => entry.path === "bip47-notification")).toBe(true);
      setActiveSendContext(aliceDb, alice);
      const notification = signed(buildActiveBip47Notification({ utxos: [notificationCoin], toAddress: BOB_CODE,
        amountSats: 546n, feeRateSatPerVb: 1 }));
      const channels = createBip47Channels(aliceDb, ALICE_CODE);
      expect(channels.getOutgoing(BOB_CODE)?.notificationStatus).toBe("prepared");
      expect(() => buildActiveSendTx({ utxos: [paymentCoin], toAddress: BOB_CODE, amountSats: 50_000n, feeRateSatPerVb: 1 }))
        .toThrow(/confirmation/);
      expect(channels.getOutgoing(BOB_CODE)?.nextIndex).toBe(0);
      const notificationTx = Transaction.fromHex(notification.txHex);
      record(aliceDb, notificationTx, 11);
      observeBip47Transactions(aliceDb, alice.snapshot(), [{ tx: notificationTx.toBuffer() }]);
      expect(channels.getOutgoing(BOB_CODE)?.notificationStatus).toBe("confirmed");
      const payment = signed(buildActiveSendTx({ utxos: [paymentCoin], toAddress: BOB_CODE,
        amountSats: 50_000n, feeRateSatPerVb: 1 }));
      const expectedDestination = deriveBip47SendPayment(deriveBip47Account(ALICE_MNEMONIC), BOB_CODE, 0);
      expect(payment.resolvedToAddress).toBe(expectedDestination.address);
      expect(channels.getOutgoing(BOB_CODE)?.nextIndex).toBe(1);
      const paymentTx = Transaction.fromHex(payment.txHex);
      const vout = paymentTx.outs.findIndex((output) => hex.encode(output.script) === hex.encode(expectedDestination.scriptPubKey));
      expect(vout).toBeGreaterThanOrEqual(0);
      expect(paymentTx.outs[vout]!.value).toBe(50_000n);

      // The recipient initially knows only its notification script. Both transactions
      // arrive in one block, so the new channel must invalidate the parsed marker.
      bobDb.blocks.insert({ height: 12, blockHashInternalHex: "bb".repeat(32), block: blockWith([notificationTx, paymentTx]) });
      bobDb.filters.append([{ height: 12, blockHashInternalHex: "bb".repeat(32), filter: Uint8Array.of(0) }]);
      bobDb.filters.markScanned([12]);
      await mod.start();
      bus.emit("sync:idle", { at: Date.now() });
      await waitFor(() => bobDb.transactions.get(payment.txid) !== null && bobDb.parsedBlocks.has(12));
      await mod.stop();
      const incoming = createBip47Channels(bobDb, BOB_CODE).listIncoming();
      expect(incoming).toHaveLength(1);
      expect(incoming[0]?.paymentCode).toBe(ALICE_CODE);
      expect(incoming[0]?.usedThrough).toBe(0);
      expect(bobDb.filters.listNeedingMatch(10).map((row) => row.height)).toContain(12);
      const receivedWatch = bob.snapshot().addresses.find((entry) => entry.address === expectedDestination.address);
      expect(receivedWatch?.path).toBe(`bip47/${ALICE_CODE}/0`);
      const snapshot = snapshotFromDb(bobDb, Date.now(), Date.now(), bob);
      expect(snapshot.balanceSats).toBe(50_000n);
      expect(snapshot.utxos).toHaveLength(1);
      expect(snapshot.utxos[0]?.txid).toBe(payment.txid);
      expect(snapshot.utxos[0]?.vout).toBe(vout);
      expect(snapshot.utxos.some((entry) => entry.txid === notification.txid)).toBe(false);
      expect(firstUnusedExternalAddress(bob.snapshot(), [])?.path.startsWith("m/84'")).toBe(true);

      // Recreating the wallet recovers the tweaked receive keys from public channel
      // metadata and the mnemonic; no plaintext derived private key is stored.
      const restored = createWallet(bobDb, { secret: BOB_MNEMONIC });
      expect(restored.snapshot().addresses.some((entry) => entry.address === expectedDestination.address)).toBe(true);
      setActiveSendContext(bobDb, restored);
      const outgoing = signed(buildActiveSendTx({ utxos: [snapshot.utxos[0]!], toAddress: DESTINATION,
        amountSats: "max", feeRateSatPerVb: 1 }));
      const spend = Transaction.fromHex(outgoing.txHex);
      const chunks = bitcoinScript.decompile(spend.ins[0]!.script)!;
      const signature = chunks[0];
      const publicKey = chunks[1];
      if (!(signature instanceof Uint8Array) || !(publicKey instanceof Uint8Array)) throw new Error("missing legacy unlocking data");
      expect(hex.encode(publicKey)).toBe(hex.encode(expectedDestination.publicKey));
      expect(signature[signature.length - 1]).toBe(1);
      expect(secp256k1.verify(secp256k1.Signature.fromDER(signature.slice(0, -1)),
        spend.hashForSignature(0, paymentTx.outs[vout]!.script, 1), publicKey)).toBe(true);
      expect(outgoing.feeSats >= BigInt(outgoing.vsize)).toBe(true);
      const notificationOutput = notificationTx.outs[0]!;
      expect(() => buildActiveSendTx({ utxos: [{ txid: notification.txid, vout: 0,
        valueSats: notificationOutput.value, scriptPubKey: notificationOutput.script }],
        toAddress: DESTINATION, amountSats: "max", feeRateSatPerVb: 1 })).toThrow(/notification outputs must not be spent/);
    } finally {
      await mod.stop();
      aliceDb.close();
      bobDb.close();
    }
  }, 30_000);

  test("enabling receive queues historical rematching and survives wallet recreation", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      const wallet = createWallet(db, { secret: BOB_MNEMONIC, addressGap: 2 });
      expect(wallet.snapshot().addresses.some((entry) => entry.path.startsWith("bip47"))).toBe(false);
      for (let height = 5; height <= 7; height++) {
        db.filters.append([{ height, blockHashInternalHex: "bb".repeat(32), filter: Uint8Array.of(0) }]);
        db.parsedBlocks.mark(height);
      }
      db.filters.markScanned([5, 6, 7]);
      const bus = createMessageBus();
      let scanWakeups = 0;
      bus.on("filters:progress", () => { scanWakeups++; });
      setActiveSendContext(db, wallet, bus);
      expect(activeBip47PaymentCode()).toBe(BOB_CODE);
      expect(db.keyValue.get(BIP47_ENABLED_KEY)).toBe("1");
      expect(db.filters.listNeedingMatch(10).map((row) => row.height)).toEqual([5, 6, 7]);
      expect(db.parsedBlocks.count()).toBe(0);
      expect(scanWakeups).toBe(1);
      db.filters.markScanned([5, 6, 7]);
      expect(activeBip47PaymentCode()).toBe(BOB_CODE);
      expect(db.filters.listNeedingMatch(10)).toEqual([]);
      expect(scanWakeups).toBe(1);
      const restored = createWallet(db, { secret: BOB_MNEMONIC });
      expect(restored.snapshot().addresses.some((entry) => entry.path === "bip47-notification")).toBe(true);
    } finally { db.close(); }
  });

  test("revokes a reorged outgoing confirmation without reusing a reserved payment index", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      const wallet = createWallet(db, { secret: ALICE_MNEMONIC, addressGap: 3 });
      const notificationCoin = fund(db, wallet, 0, 50_000n);
      const paymentCoin = fund(db, wallet, 1, 100_000n);
      setActiveSendContext(db, wallet);
      const notification = signed(buildActiveBip47Notification({ utxos: [notificationCoin], toAddress: BOB_CODE,
        amountSats: 546n, feeRateSatPerVb: 1 }));
      const tx = Transaction.fromHex(notification.txHex);
      record(db, tx, 11);
      const first = signed(buildActiveSendTx({ utxos: [paymentCoin], toAddress: BOB_CODE, amountSats: 10_000n, feeRateSatPerVb: 1 }));
      expect(() => validateActivePaymentBroadcast(first)).not.toThrow();
      const channels = createBip47Channels(db, ALICE_CODE);
      expect(channels.getOutgoing(BOB_CODE)?.nextIndex).toBe(1);
      // A stale transaction row can outlive its header while reorg processing
      // is in flight. Neither build nor broadcast can treat that as confirmation.
      db.headers.replaceAfter(10, [{ height: 11, hashInternalHex: "cc".repeat(32),
        header: new Uint8Array(80), cumulativeWork: 11n }]);
      expect(db.transactions.get(notification.txid)).not.toBeNull();
      expect(() => validateActivePaymentBroadcast(first)).toThrow(/no longer confirmed/);
      expect(() => buildActiveSendTx({ utxos: [paymentCoin], toAddress: BOB_CODE,
        amountSats: 10_000n, feeRateSatPerVb: 1 })).toThrow(/confirmation/);
      expect(channels.getOutgoing(BOB_CODE)?.nextIndex).toBe(1);
      db.rewindAfter(10);
      expect(() => validateActivePaymentBroadcast(first)).toThrow(/no longer confirmed/);
      expect(() => buildActiveSendTx({ utxos: [paymentCoin], toAddress: BOB_CODE, amountSats: 10_000n, feeRateSatPerVb: 1 }))
        .toThrow(/confirmation/);
      expect(channels.getOutgoing(BOB_CODE)?.notificationStatus).toBe("broadcast");
      expect(channels.getOutgoing(BOB_CODE)?.nextIndex).toBe(1);
      record(db, tx, 12);
      const restored = createWallet(db, { secret: ALICE_MNEMONIC });
      setActiveSendContext(db, restored);
      const second = signed(buildActiveSendTx({ utxos: [paymentCoin], toAddress: BOB_CODE, amountSats: 10_000n, feeRateSatPerVb: 1 }));
      expect(second.resolvedToAddress).not.toBe(first.resolvedToAddress);
      expect(second.resolvedToAddress).toBe(deriveBip47SendPayment(deriveBip47Account(ALICE_MNEMONIC), BOB_CODE, 1).address);
      expect(channels.getOutgoing(BOB_CODE)?.nextIndex).toBe(2);
    } finally { db.close(); }
  });
});
