import { decodePaymentCode, encodePaymentCode } from "./bip47.ts";

export const BIP47_CHANNELS_KEY = "bip47_channels_v1";
const INDEX_LIMIT = 0x80000000;
const MAX_CONTACTS = 10_000;

export type OutgoingBip47Channel = {
  paymentCode: string;
  notificationTxid: string | null;
  notificationStatus: "prepared" | "broadcast" | "confirmed";
  /** Next unreserved index; INDEX_LIMIT means exhausted. */
  nextIndex: number;
};
export type IncomingBip47Channel = {
  paymentCode: string;
  notificationTxids: string[];
  usedThrough: number;
};
type State = {
  version: 1;
  identity: string;
  outgoing: OutgoingBip47Channel[];
  incoming: IncomingBip47Channel[];
};
type ChannelDb = {
  keyValue: { get(key: string): string | null; set(key: string, value: string): void };
  transaction(fn: () => void): void;
};

function canonicalCode(code: string): string {
  return encodePaymentCode(decodePaymentCode(code));
}
function checkTxid(txid: string): void {
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error("invalid BIP47 notification txid");
}
function checkIndex(index: number, min: number, max: number): void {
  if (!Number.isSafeInteger(index) || index < min || index > max) {
    throw new Error("invalid BIP47 channel index");
  }
}

/**
 * Public channel metadata only. Synchronous transactions reserve indexes before
 * callers can sign or broadcast. Use the real SQLite transaction implementation.
 */
export function createBip47Channels(db: ChannelDb, identityCode: string) {
  const identity = canonicalCode(identityCode);

  function load(): State {
    const raw = db.keyValue.get(BIP47_CHANNELS_KEY);
    if (raw === null) return { version: 1, identity, outgoing: [], incoming: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      const state = parsed as State;
      if (state === null || typeof state !== "object" || state.version !== 1 || state.identity !== identity ||
        !Array.isArray(state.outgoing) || !Array.isArray(state.incoming) ||
        state.outgoing.length > MAX_CONTACTS || state.incoming.length > MAX_CONTACTS) throw new Error();
      const outgoingCodes = new Set<string>();
      for (const channel of state.outgoing) {
        if (!channel || canonicalCode(channel.paymentCode) !== channel.paymentCode || outgoingCodes.has(channel.paymentCode)) throw new Error();
        outgoingCodes.add(channel.paymentCode);
        checkIndex(channel.nextIndex, 0, INDEX_LIMIT);
        if (!["prepared", "broadcast", "confirmed"].includes(channel.notificationStatus)) throw new Error();
        if (channel.notificationTxid !== null) checkTxid(channel.notificationTxid);
        else if (channel.notificationStatus !== "prepared") throw new Error();
      }
      const incomingCodes = new Set<string>();
      for (const channel of state.incoming) {
        if (!channel || canonicalCode(channel.paymentCode) !== channel.paymentCode || incomingCodes.has(channel.paymentCode) ||
          !Array.isArray(channel.notificationTxids) || channel.notificationTxids.length === 0 || channel.notificationTxids.length > MAX_CONTACTS) throw new Error();
        incomingCodes.add(channel.paymentCode);
        checkIndex(channel.usedThrough, -1, INDEX_LIMIT - 1);
        const unique = new Set(channel.notificationTxids);
        if (unique.size !== channel.notificationTxids.length) throw new Error();
        channel.notificationTxids.forEach(checkTxid);
      }
      return state;
    } catch {
      // Never silently reset a corrupt counter: that would reuse addresses.
      throw new Error("invalid BIP47 channel state or wallet identity mismatch");
    }
  }

  function modify<T>(fn: (state: State) => T): T {
    let result!: T;
    db.transaction(() => {
      const state = load();
      result = fn(state);
      db.keyValue.set(BIP47_CHANNELS_KEY, JSON.stringify(state));
    });
    return result;
  }

  function findOutgoing(state: State, code: string): OutgoingBip47Channel {
    const canonical = canonicalCode(code);
    const channel = state.outgoing.find((entry) => entry.paymentCode === canonical);
    if (!channel) throw new Error("BIP47 notification channel is missing");
    return channel;
  }

  return {
    listOutgoing: () => load().outgoing,
    listIncoming: () => load().incoming,
    getOutgoing(code: string): OutgoingBip47Channel | null {
      const canonical = canonicalCode(code);
      return load().outgoing.find((entry) => entry.paymentCode === canonical) ?? null;
    },
    prepareNotification(code: string, txid: string): void {
      const canonical = canonicalCode(code);
      checkTxid(txid);
      modify((state) => {
        const existing = state.outgoing.find((entry) => entry.paymentCode === canonical);
        if (existing) {
          if (existing.notificationTxid !== txid) {
            existing.notificationTxid = txid;
            existing.notificationStatus = "prepared";
          }
          return;
        }
        if (state.outgoing.length >= MAX_CONTACTS) throw new Error("BIP47 contact limit reached");
        state.outgoing.push({ paymentCode: canonical, notificationTxid: txid, notificationStatus: "prepared", nextIndex: 0 });
      });
    },
    markNotificationBroadcast(code: string, txid: string): void {
      checkTxid(txid);
      modify((state) => {
        const channel = findOutgoing(state, code);
        if (channel.notificationTxid !== txid) throw new Error("BIP47 notification txid mismatch");
        if (channel.notificationStatus !== "confirmed") channel.notificationStatus = "broadcast";
      });
    },
    /** Call only after validating the transaction's inclusion in the active chain. */
    confirmNotification(code: string, txid: string): void {
      checkTxid(txid);
      modify((state) => {
        const channel = findOutgoing(state, code);
        if (channel.notificationTxid !== txid) throw new Error("BIP47 notification txid mismatch");
        channel.notificationStatus = "confirmed";
      });
    },
    /** Reorgs can revoke confirmation, but never erase previously reserved indexes. */
    revokeNotificationConfirmation(code: string): void {
      modify((state) => {
        const channel = findOutgoing(state, code);
        if (channel.notificationStatus === "confirmed") channel.notificationStatus = "broadcast";
      });
    },
    reserveSendIndex(code: string): number {
      return modify((state) => {
        const channel = findOutgoing(state, code);
        if (channel.notificationStatus !== "confirmed") throw new Error("BIP47 notification must be confirmed before sending");
        if (channel.nextIndex >= INDEX_LIMIT) throw new Error("BIP47 payment indexes exhausted");
        return channel.nextIndex++;
      });
    },
    /** Add only after validating and unblinding a notification transaction. */
    addIncoming(code: string, notificationTxid: string): void {
      const canonical = canonicalCode(code);
      checkTxid(notificationTxid);
      modify((state) => {
        const existing = state.incoming.find((entry) => entry.paymentCode === canonical);
        if (existing) {
          if (!existing.notificationTxids.includes(notificationTxid)) {
            if (existing.notificationTxids.length >= MAX_CONTACTS) throw new Error("BIP47 notification limit reached");
            existing.notificationTxids.push(notificationTxid);
          }
        } else {
          if (state.incoming.length >= MAX_CONTACTS) throw new Error("BIP47 contact limit reached");
          state.incoming.push({ paymentCode: canonical, notificationTxids: [notificationTxid], usedThrough: -1 });
        }
      });
    },
    markIncomingUsed(code: string, index: number): void {
      const canonical = canonicalCode(code);
      checkIndex(index, 0, INDEX_LIMIT - 1);
      modify((state) => {
        const channel = state.incoming.find((entry) => entry.paymentCode === canonical);
        if (!channel) throw new Error("BIP47 incoming channel is missing");
        channel.usedThrough = Math.max(channel.usedThrough, index);
      });
    },
  };
}

export type Bip47Channels = ReturnType<typeof createBip47Channels>;
