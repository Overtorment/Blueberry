import {
  Networks,
  Protocol,
  ProtocolClosedError,
  answerPing,
  completeVersionHandshake,
  decodeTransaction,
  equalBytes,
  hexToBytes,
  transactionId,
  type ByteDuplex,
  type Transaction,
} from "bip324";

const MSG_TX = 1;
const MSG_WTX = 5;

export type BroadcastTxV2Options = {
  port: number;
  name: string;
  version: string;
  /** BIP-324 key exchange + version/verack. Default 15s. */
  handshakeTimeoutMs?: number;
  ackTimeoutMs?: number;
  signal?: AbortSignal;
};

export function decodeBroadcastTx(txHex: string): Transaction {
  try {
    return decodeTransaction(hexToBytes(txHex));
  } catch {
    throw new Error("invalid transaction hex");
  }
}

function abortError(signal: AbortSignal | undefined, fallback: string): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback);
}

/** Close / EOF after we already sent `tx` — not a protocol/auth failure. */
function isSessionGone(err: unknown): boolean {
  if (err instanceof ProtocolClosedError) return true;
  if (!(err instanceof Error)) return false;
  const message = err.message;
  return (
    message.includes("unexpected EOF") || message.includes("closed duplex")
  );
}

/** Close duplex when `signal` aborts or `ms` elapses (unblocks bip324 reads). */
function armDuplexDeadline(
  duplex: ByteDuplex,
  signal: AbortSignal | undefined,
  ms: number,
  onTimeout: () => void,
): () => void {
  const timer = setTimeout(() => {
    onTimeout();
    void duplex.close().catch(() => {});
  }, ms);
  timer.unref?.();
  const onAbort = () => {
    clearTimeout(timer);
    void duplex.close().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  return () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  };
}

function inventoryMentionsTx(
  inventory: { type: number; hash: Uint8Array }[],
  txidInternal: Uint8Array,
): boolean {
  return inventory.some(
    (item) =>
      (item.type === MSG_TX || item.type === MSG_WTX) &&
      equalBytes(item.hash, txidInternal),
  );
}

/**
 * BIP-324 session: version/verack, send `tx`, succeed on inv/getdata for the
 * txid, or ack timeout / peer close without `reject`.
 */
export async function broadcastTxV2(
  duplex: ByteDuplex,
  txHex: string,
  options: BroadcastTxV2Options,
): Promise<void> {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
  const ackTimeoutMs = options.ackTimeoutMs ?? 15_000;
  const signal = options.signal;

  const wireTx = decodeBroadcastTx(txHex);
  const txidInternal = transactionId(wireTx);

  if (signal?.aborted) {
    throw abortError(signal, "broadcast aborted");
  }

  // BIP-324 ellswift + version/verack: peer can accept TCP and never reply
  // (or speak v1 only). Closing the duplex unblocks readExactly.
  let handshakeTimedOut = false;
  const disarmHandshake = armDuplexDeadline(
    duplex,
    signal,
    handshakeTimeoutMs,
    () => {
      handshakeTimedOut = true;
    },
  );

  let protocol: Protocol;
  try {
    protocol = await Protocol.connect(duplex, {
      role: "initiator",
      network: Networks.mainnet,
    });
    await completeVersionHandshake(protocol, {
      port: options.port,
      name: options.name,
      version: options.version,
    });
  } catch (err) {
    if (signal?.aborted) throw abortError(signal, "broadcast aborted");
    if (handshakeTimedOut) throw new Error("handshake timeout");
    throw err;
  } finally {
    disarmHandshake();
  }

  let ackTimedOut = false;
  const disarmAck = armDuplexDeadline(duplex, signal, ackTimeoutMs, () => {
    ackTimedOut = true;
  });
  try {
    await protocol.writeMessage({ command: "tx", payload: wireTx });
    for (;;) {
      if (signal?.aborted) {
        throw abortError(signal, "broadcast aborted");
      }
      try {
        const msg = await protocol.readMessage();
        if (
          msg.command === "opaque" &&
          msg.type.kind === "long" &&
          msg.type.command === "reject"
        ) {
          throw new Error("peer rejected transaction");
        }
        if (
          (msg.command === "inv" || msg.command === "getdata") &&
          inventoryMentionsTx(msg.payload.inventory, txidInternal)
        ) {
          return;
        }
        await answerPing(protocol, msg);
      } catch (err) {
        if (signal?.aborted) {
          throw abortError(signal, "broadcast aborted");
        }
        if (err instanceof Error && err.message === "peer rejected transaction") {
          throw err;
        }
        if (ackTimedOut || isSessionGone(err)) return;
        throw err;
      }
    }
  } finally {
    disarmAck();
    try {
      await protocol.close();
    } catch {
      // ignore
    }
  }
}
