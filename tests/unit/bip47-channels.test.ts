import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { BIP47_CHANNELS_KEY, createBip47Channels } from "../../src/wallet/bip47-channels.ts";
import { deriveBip47Account, paymentCodeFromAccount } from "../../src/wallet/bip47.ts";

const ALICE = paymentCodeFromAccount(deriveBip47Account("response seminar brave tip suit recall often sound stick owner lottery motion"));
const BOB = paymentCodeFromAccount(deriveBip47Account("reward upper indicate eight swift arch injury crystal super wrestle already dentist"));
const TXID = "11".repeat(32);

describe("BIP47 durable channel state", () => {
  test("persists reservations across actual database close/reopen and stale store instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "blueberry-bip47-"));
    try {
      const path = join(dir, "wallet.sqlite");
      let db = createSqliteDatabase(path);
      const store = createBip47Channels(db, ALICE);
      store.prepareNotification(BOB, TXID);
      expect(() => store.reserveSendIndex(BOB)).toThrow(/confirmed/);
      store.markNotificationBroadcast(BOB, TXID);
      expect(() => store.reserveSendIndex(BOB)).toThrow(/confirmed/);
      store.confirmNotification(BOB, TXID);
      expect(store.reserveSendIndex(BOB)).toBe(0);
      const otherStore = createBip47Channels(db, ALICE);
      expect(otherStore.reserveSendIndex(BOB)).toBe(1);
      expect(store.reserveSendIndex(BOB)).toBe(2);
      db.close();
      db = createSqliteDatabase(path);
      expect(createBip47Channels(db, ALICE).reserveSendIndex(BOB)).toBe(3);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reorgs, replaced notifications and failed broadcasts never reset reservations", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      const store = createBip47Channels(db, ALICE);
      store.prepareNotification(BOB, TXID);
      store.confirmNotification(BOB, TXID);
      expect(store.reserveSendIndex(BOB)).toBe(0);
      store.prepareNotification(BOB, TXID);
      store.markNotificationBroadcast(BOB, TXID);
      expect(store.getOutgoing(BOB)?.notificationStatus).toBe("confirmed");
      store.revokeNotificationConfirmation(BOB);
      expect(() => store.reserveSendIndex(BOB)).toThrow(/confirmed/);
      const replacement = "22".repeat(32);
      store.prepareNotification(BOB, replacement);
      expect(() => store.confirmNotification(BOB, TXID)).toThrow(/mismatch/);
      store.confirmNotification(BOB, replacement);
      expect(store.reserveSendIndex(BOB)).toBe(1);
    } finally { db.close(); }
  });

  test("incoming notifications are idempotent and receive windows only grow", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      const store = createBip47Channels(db, ALICE);
      store.addIncoming(BOB, TXID);
      store.addIncoming(BOB, TXID);
      store.addIncoming(BOB, "22".repeat(32));
      expect(store.listIncoming()).toEqual([{ paymentCode: BOB,
        notificationTxids: [TXID, "22".repeat(32)], usedThrough: -1 }]);
      store.markIncomingUsed(BOB, 5);
      store.markIncomingUsed(BOB, 2);
      expect(createBip47Channels(db, ALICE).listIncoming()[0]?.usedThrough).toBe(5);
      expect(store.listOutgoing()).toEqual([]);
      expect(() => store.markIncomingUsed(ALICE, 1)).toThrow(/missing/);
    } finally { db.close(); }
  });

  test("malformed saved state fails closed without overwriting it", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      const store = createBip47Channels(db, ALICE);
      store.prepareNotification(BOB, TXID);
      const valid = db.keyValue.get(BIP47_CHANNELS_KEY)!;
      const state = JSON.parse(valid);
      for (const raw of ["{", "null", "{}", JSON.stringify({ ...state, version: 2 }),
        JSON.stringify({ ...state, identity: BOB }),
        JSON.stringify({ ...state, outgoing: [{ ...state.outgoing[0], nextIndex: -1 }] }),
        JSON.stringify({ ...state, outgoing: [state.outgoing[0], state.outgoing[0]] }),
        JSON.stringify({ ...state, outgoing: [{ ...state.outgoing[0], notificationStatus: "made-up" }] })]) {
        db.keyValue.set(BIP47_CHANNELS_KEY, raw);
        expect(() => store.listOutgoing()).toThrow(/invalid BIP47 channel state/);
        expect(() => store.prepareNotification(BOB, TXID)).toThrow(/invalid BIP47 channel state/);
        expect(db.keyValue.get(BIP47_CHANNELS_KEY)).toBe(raw);
      }
      db.keyValue.set(BIP47_CHANNELS_KEY, valid);
      expect(() => createBip47Channels(db, BOB).listOutgoing()).toThrow(/identity mismatch/);
    } finally { db.close(); }
  });

  test("does not release a reservation when the durable write fails", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      const good = createBip47Channels(db, ALICE);
      good.prepareNotification(BOB, TXID);
      good.confirmNotification(BOB, TXID);
      const failing = createBip47Channels({ transaction: db.transaction,
        keyValue: { get: db.keyValue.get, set: () => { throw new Error("disk full"); } },
      }, ALICE);
      expect(() => failing.reserveSendIndex(BOB)).toThrow(/disk full/);
      expect(good.reserveSendIndex(BOB)).toBe(0);
    } finally { db.close(); }
  });

  test("counter exhaustion and invalid input cannot reset indexes", () => {
    const db = createSqliteDatabase(":memory:");
    try {
      const store = createBip47Channels(db, ALICE);
      store.prepareNotification(BOB, TXID);
      store.confirmNotification(BOB, TXID);
      const state = JSON.parse(db.keyValue.get(BIP47_CHANNELS_KEY)!);
      state.outgoing[0].nextIndex = 0x7fffffff;
      db.keyValue.set(BIP47_CHANNELS_KEY, JSON.stringify(state));
      expect(store.reserveSendIndex(BOB)).toBe(0x7fffffff);
      expect(() => store.reserveSendIndex(BOB)).toThrow(/exhausted/);
      expect(() => store.prepareNotification(BOB, "invalid")).toThrow(/txid/);
      expect(() => store.addIncoming("invalid", TXID)).toThrow();
      store.addIncoming(BOB, TXID);
      expect(() => store.markIncomingUsed(BOB, -1)).toThrow(/index/);
    } finally { db.close(); }
  });
});
