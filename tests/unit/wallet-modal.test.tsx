import { describe, expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { Transaction } from "bitcoinjs-lib";
import { WalletModal } from "../../src/tui/components/WalletModal.tsx";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createWallet } from "../../src/wallet/wallet.ts";
import { deriveBip47Account, paymentCodeFromAccount } from "../../src/wallet/bip47.ts";
import { BIP47_ENABLED_KEY } from "../../src/wallet/bip47-wallet.ts";
import { setActiveSendContext } from "../../src/tui/send-context.ts";
import { createReceiveAddressStore } from "../../src/tui/receive-address-store.ts";
import { setActiveReceiveAddressStore } from "../../src/tui/use-receive-address.ts";
import { createWalletTxsStore, snapshotFromDb } from "../../src/tui/wallet-txs-store.ts";
import { setActiveWalletTxsStore } from "../../src/tui/use-wallet-txs.ts";
import { setActivePaymentLabelContext } from "../../src/tui/payment-label-actions.ts";
import { setActiveBroadcastStore } from "../../src/tui/use-broadcast.ts";
import { createBroadcastStore } from "../../src/tui/broadcast-store.ts";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const RECIPIENT = "PM8TJTLJbPRGxSbc8EJi42Wrr6QbNSaSSVJ5Y3E4pbCYiTHUskHg13935Ubb7q8tx9GVbh2UuRnBc3WSyJHhUrw8KhprKnn9eDznYGieTzFcwQRya4GA";
type Setup = Awaited<ReturnType<typeof testRender>>;

async function renderModal(kind: "receive" | "send"): Promise<Setup> {
  let setup!: Setup;
  await act(async () => { setup = await testRender(<WalletModal kind={kind} />, { width: 120, height: 50 }); });
  // React commits at the end of act; render the resulting terminal frame after.
  await setup.flush();
  return setup;
}

async function press(setup: Setup, key: string, modifiers?: { ctrl?: boolean }): Promise<void> {
  await act(async () => { setup.mockInput.pressKey(key, modifiers); });
  await setup.flush();
}

async function input(setup: Setup, text: string, paste = false): Promise<void> {
  await act(async () => {
    if (paste) await setup.mockInput.pasteBracketedText(text);
    else await setup.mockInput.typeText(text);
  });
  await setup.flush();
}

describe("BIP47 receive terminal flow", () => {
  test("enables notification watching only when P is pressed and shows the complete code", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: MNEMONIC, addressGap: 2 });
    setActiveSendContext(db, wallet);
    const receive = createReceiveAddressStore();
    receive.refresh(db, wallet);
    setActiveReceiveAddressStore(receive);
    const code = paymentCodeFromAccount(deriveBip47Account(MNEMONIC));
    const address = receive.get().address!;
    let setup: Setup | undefined;
    try {
      setup = await renderModal("receive");
      expect(db.keyValue.get(BIP47_ENABLED_KEY)).not.toBe("1");
      expect(setup.captureCharFrame().replace(/\s/g, "")).toContain(address);
      await press(setup, "p");
      expect(db.keyValue.get(BIP47_ENABLED_KEY)).toBe("1");
      expect(setup.captureCharFrame()).toContain("BIP47 payment code");
      expect(setup.captureCharFrame().replace(/\s/g, "")).toContain(code);
      await press(setup, "p");
      expect(setup.captureCharFrame().replace(/\s/g, "")).toContain(address);
      expect(db.keyValue.get(BIP47_ENABLED_KEY)).toBe("1");
    } finally {
      await act(async () => { setup?.renderer.destroy(); });
      db.close();
    }
  });

  test("shows an explanatory message for an address-only wallet", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" });
    setActiveSendContext(db, wallet);
    const receive = createReceiveAddressStore();
    receive.refresh(db, wallet);
    setActiveReceiveAddressStore(receive);
    let setup: Setup | undefined;
    try {
      setup = await renderModal("receive");
      await press(setup, "p");
      expect(setup.captureCharFrame().replace(/\s/g, "")).toContain("BIP47paymentcodesrequireamnemonicwallet");
      expect(db.keyValue.get(BIP47_ENABLED_KEY)).not.toBe("1");
    } finally {
      await act(async () => { setup?.renderer.destroy(); });
      db.close();
    }
  });
});

describe("BIP47 notification terminal flow", () => {
  test("Ctrl+N creates a clearly marked notification preview without a payment or broadcast", async () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: MNEMONIC, addressGap: 2 });
    const coin = wallet.snapshot().addresses.find((address) => !address.change)!;
    const funding = new Transaction();
    funding.addInput(Buffer.alloc(32, 42), 0);
    funding.addOutput(coin.scriptPubKey, 100_000n);
    db.transactions.upsert({ txid: funding.getId(), height: 900_000, txIndex: 0,
      blockHashInternalHex: "aa".repeat(32), tx: funding.toBuffer(), netDeltaSats: 100_000 });
    const txs = createWalletTxsStore();
    txs.apply(snapshotFromDb(db, Date.now(), Date.now(), wallet));
    setActiveWalletTxsStore(txs);
    setActiveSendContext(db, wallet);
    setActivePaymentLabelContext(db);
    const broadcast = createBroadcastStore();
    setActiveBroadcastStore(broadcast);
    let setup: Setup | undefined;
    try {
      setup = await renderModal("send");
      await press(setup, " ");
      await press(setup, "\r");
      await input(setup, RECIPIENT, true);
      await press(setup, "n", { ctrl: true });
      expect(setup.captureCharFrame()).toContain("BIP47 notification ONLY");
      expect(setup.captureCharFrame()).toContain("Fee rate");
      await input(setup, "1");
      await press(setup, "\r");
      const frame = setup.captureCharFrame();
      expect(frame).toContain("BIP47 notification ONLY");
      expect(frame.replace(/\s/g, "")).toContain("546satsestablishestheBIP47channel");
      expect(frame.replace(/\s/g, "")).toContain("Waitforconfirmation");
      expect(frame).toContain("Notification address:");
      expect(frame).toContain("Broadcast");
      expect(broadcast.get().phase).toBe("idle");
      expect(db.txPaymentLabels.list().map((row) => row.label)).toContain("BIP47 notification");
    } finally {
      await act(async () => { setup?.renderer.destroy(); });
      db.close();
    }
  });
});
