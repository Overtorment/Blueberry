import {
  Networks,
  Protocol,
  ProtocolClosedError,
  answerPing,
  completeVersionHandshake,
  decodeTransaction,
  encodeTransaction,
  equalBytes,
  hexToBytes,
  sha256d,
  transactionId,
  type ByteDuplex,
  type Transaction,
} from "bip324";
import { log, logError } from "../../log.ts";

const MSG_TX = 1;
const MSG_WTX = 5;
const MSG_WITNESS_FLAG = 1 << 30;

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

function describeV2Command(msg: {
  command: string;
  type?: { kind?: string; command?: string };
}): string {
  if (msg.command !== "opaque") return msg.command;
  const inner = msg.type?.command ?? msg.type?.kind;
  return inner ? `opaque:${inner}` : "opaque";
}

function inventoryMentionsTx(
  inventory: { type: number; hash: Uint8Array }[],
  txidInternal: Uint8Array,
  wtxidInternal: Uint8Array,
): boolean {
  return inventory.some((item) => {
    if (item.type === MSG_WTX) return equalBytes(item.hash, wtxidInternal);
    const base = item.type & ~MSG_WITNESS_FLAG;
    return base === MSG_TX && equalBytes(item.hash, txidInternal);
  });
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
  const wtxidInternal = sha256d(encodeTransaction(wireTx));

  if (signal?.aborted) {
    throw abortError(signal, "broadcast aborted");
  }

  // BIP-324 ellswift + version/verack: peer can accept TCP and never reply
  // (or speak v1 only). Closing the duplex unblocks readExactly.
  let handshakeTimedOut = false;
  const handshakeStartedAt = Date.now();
  const disarmHandshake = armDuplexDeadline(
    duplex,
    signal,
    handshakeTimeoutMs,
    () => {
      handshakeTimedOut = true;
    },
  );

  let protocol: Protocol;
  let ellswiftDone = false;
  try {
    log("broadcast", "v2 ellswift start");
    protocol = await Protocol.connect(duplex, {
      role: "initiator",
      network: Networks.mainnet,
    });
    log(
      "broadcast",
      `v2 ellswift ok elapsedMs=${Math.max(0, Date.now() - handshakeStartedAt)}`,
    );
    ellswiftDone = true;
    const versionStartedAt = Date.now();
    log("broadcast", "v2 version-handshake start");
    await completeVersionHandshake(protocol, {
      port: options.port,
      name: options.name,
      version: options.version,
    });
    log(
      "broadcast",
      `v2 version-handshake ok elapsedMs=${Math.max(0, Date.now() - versionStartedAt)}`,
    );
  } catch (err) {
    if (signal?.aborted) throw abortError(signal, "broadcast aborted");
    const elapsedMs = Math.max(0, Date.now() - handshakeStartedAt);
    if (handshakeTimedOut) {
      const timeout = new Error("handshake timeout");
      logError(
        "broadcast",
        `v2 handshake fail phase=timeout elapsedMs=${elapsedMs}`,
        timeout,
      );
      throw timeout;
    }
    logError(
      "broadcast",
      `v2 handshake fail phase=${ellswiftDone ? "version-handshake" : "ellswift"} elapsedMs=${elapsedMs}`,
      err,
    );
    throw err;
  } finally {
    disarmHandshake();
  }

  let ackTimedOut = false;
  const disarmAck = armDuplexDeadline(duplex, signal, ackTimeoutMs, () => {
    ackTimedOut = true;
  });
  try {
    log("broadcast", "v2 send-tx");
    await protocol.writeMessage({ command: "tx", payload: wireTx });
    for (;;) {
      if (signal?.aborted) {
        throw abortError(signal, "broadcast aborted");
      }
      try {
        const msg = await protocol.readMessage();
        log("broadcast", `v2 recv command=${describeV2Command(msg)}`);
        if (
          msg.command === "opaque" &&
          msg.type.kind === "long" &&
          msg.type.command === "reject"
        ) {
          logError("broadcast", "v2 reject");
          throw new Error("peer rejected transaction");
        }
        if (
          (msg.command === "inv" || msg.command === "getdata") &&
          inventoryMentionsTx(msg.payload.inventory, txidInternal, wtxidInternal)
        ) {
          log("broadcast", `v2 ack ${msg.command}`);
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
        if (ackTimedOut || isSessionGone(err)) {
          log(
            "broadcast",
            ackTimedOut
              ? "v2 ack timeout (accepted)"
              : "v2 peer-closed after tx (accepted)",
          );
          return;
        }
        logError("broadcast", "v2 session error", err);
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
