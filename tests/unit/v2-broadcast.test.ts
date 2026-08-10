import { describe, expect, test } from "bun:test";
import {
  Networks,
  Protocol,
  encodeTransaction,
  equalBytes,
  pairedByteDuplexes,
  transactionId,
  type ByteDuplex,
  type Transaction,
} from "bip324";
import { broadcastTxV2 } from "../../src/modules/broadcast/v2-broadcast.ts";
import { APP_NAME, APP_VERSION } from "../../src/net/user-agent.ts";

const MSG_TX = 1;

function sampleTx(): Transaction {
  return {
    version: 2,
    inputs: [
      {
        previousOutput: { hash: new Uint8Array(32), index: 0xffffffff },
        scriptSig: new Uint8Array([0x00]),
        sequence: 0xffffffff,
      },
    ],
    outputs: [
      {
        value: 50_000_000n,
        scriptPubKey: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20)),
      },
    ],
    lockTime: 0,
  };
}

/** Minimal BIP-324 responder: handshake, capture tx, optional inv/reject. */
async function runPeer(
  server: ByteDuplex,
  afterTx: "inv" | "silent" | "reject",
): Promise<Transaction> {
  const protocol = await Protocol.connect(server, {
    role: "responder",
    network: Networks.mainnet,
  });
  let gotVersion = false;
  let gotVerack = false;
  while (!gotVersion || !gotVerack) {
    const msg = await protocol.readMessage();
    if (msg.command === "version") {
      gotVersion = true;
      await protocol.writeMessage({
        command: "version",
        payload: msg.payload,
      });
      await protocol.writeMessage({ command: "verack" });
    } else if (msg.command === "verack") {
      gotVerack = true;
    }
  }
  for (;;) {
    const msg = await protocol.readMessage();
    if (msg.command !== "tx") continue;
    if (afterTx === "inv") {
      await protocol.writeMessage({
        command: "inv",
        payload: {
          inventory: [{ type: MSG_TX, hash: transactionId(msg.payload) }],
        },
      });
    } else if (afterTx === "reject") {
      await protocol.writeMessage({
        command: "opaque",
        type: { kind: "long", command: "reject" },
        payload: new Uint8Array([0]),
      });
    }
    return msg.payload;
  }
}

describe("broadcastTxV2", () => {
  test("sends tx over BIP-324 and succeeds on inv for that txid", async () => {
    const [client, server] = pairedByteDuplexes();
    const tx = sampleTx();
    const txHex = Buffer.from(encodeTransaction(tx)).toString("hex");
    const wantId = transactionId(tx);

    const peer = runPeer(server, "inv");
    await broadcastTxV2(client, txHex, {
      port: 8333,
      name: APP_NAME,
      version: APP_VERSION,
      ackTimeoutMs: 2_000,
    });
    const got = await peer;
    expect(equalBytes(transactionId(got), wantId)).toBe(true);

    await client.close();
    await server.close();
  });

  test("succeeds on ack timeout when peer stays silent after tx", async () => {
    const [client, server] = pairedByteDuplexes();
    const tx = sampleTx();
    const txHex = Buffer.from(encodeTransaction(tx)).toString("hex");

    const peer = runPeer(server, "silent");
    await broadcastTxV2(client, txHex, {
      port: 8333,
      name: APP_NAME,
      version: APP_VERSION,
      ackTimeoutMs: 40,
    });
    const got = await peer;
    expect(equalBytes(transactionId(got), transactionId(tx))).toBe(true);

    await client.close();
    await server.close();
  });

  test("rejects invalid hex before dialing protocol", async () => {
    const [client, server] = pairedByteDuplexes();
    await expect(
      broadcastTxV2(client, "not-hex", {
        port: 8333,
        name: APP_NAME,
        version: APP_VERSION,
      }),
    ).rejects.toThrow(/invalid transaction hex/i);
    await client.close();
    await server.close();
  });

  test("times out when peer never completes BIP-324 handshake", async () => {
    const [client, server] = pairedByteDuplexes();
    const txHex = Buffer.from(encodeTransaction(sampleTx())).toString("hex");
    // Peer accepts the TCP-like duplex but never speaks BIP-324.
    await expect(
      broadcastTxV2(client, txHex, {
        port: 8333,
        name: APP_NAME,
        version: APP_VERSION,
        handshakeTimeoutMs: 40,
        ackTimeoutMs: 40,
      }),
    ).rejects.toThrow(/handshake timeout/i);
    await client.close();
    await server.close();
  }, 2_000);

  test("fails when peer sends reject", async () => {
    const [client, server] = pairedByteDuplexes();
    const txHex = Buffer.from(encodeTransaction(sampleTx())).toString("hex");
    const peer = runPeer(server, "reject");
    await expect(
      broadcastTxV2(client, txHex, {
        port: 8333,
        name: APP_NAME,
        version: APP_VERSION,
        ackTimeoutMs: 2_000,
      }),
    ).rejects.toThrow(/rejected/i);
    await peer;
    await client.close();
    await server.close();
  });
});
