import { describe, expect, test } from "bun:test";
import {
  Networks,
  Protocol,
  decodeBlock,
  hexToBytes,
  pairedByteDuplexes,
} from "bip324";
import {
  MSG_BLOCK,
  MSG_WITNESS_BLOCK,
  openBlockSession,
} from "../../src/net/block-sync.ts";

const GENESIS_BLOCK_HEX =
  "01000000" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" +
  "29ab5f49ffff001d1dac2b7c" +
  "01" +
  "01000000" +
  "01" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "ffffffff" +
  "4d" +
  "04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73" +
  "ffffffff" +
  "01" +
  "00f2052a01000000" +
  "43" +
  "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac" +
  "00000000";

async function answerVersionVerack(protocol: Protocol, port: number): Promise<void> {
  const msg = await protocol.readMessage();
  if (msg.command !== "version") throw new Error("expected version");
  await protocol.writeMessage({
    command: "version",
    payload: {
      version: 70_016,
      services: 1033n,
      timestamp: BigInt(Math.floor(Date.now() / 1_000)),
      receiver: { services: 0n, ip: new Uint8Array(16), port },
      sender: { services: 0n, ip: new Uint8Array(16), port: 0 },
      nonce: 1n,
      userAgent: "/test/",
      startHeight: 0,
      relay: false,
    },
  });
  await protocol.writeMessage({ command: "verack" });
  for (;;) {
    const next = await protocol.readMessage();
    if (next.command === "verack") return;
    // sendaddrv2 / other post-version noise
  }
}

describe("openBlockSession", () => {
  test("maps connect failure to ok:false", async () => {
    const result = await openBlockSession("1.2.3.4", 8333, {
      connectTimeoutMs: 100,
      syncTimeoutMs: 100,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(result.ok).toBe(false);
  });

  test("getBlock getdata uses MSG_WITNESS_BLOCK", async () => {
    const [clientSide, serverSide] = pairedByteDuplexes();
    const hash = new Uint8Array(32).fill(0xab);
    const genesis = decodeBlock(hexToBytes(GENESIS_BLOCK_HEX));

    const server = (async () => {
      const protocol = await Protocol.connect(serverSide, {
        role: "responder",
        network: Networks.mainnet,
      });
      await answerVersionVerack(protocol, 8333);
      const msg = await protocol.readMessage();
      expect(msg.command).toBe("getdata");
      if (msg.command !== "getdata") throw new Error("expected getdata");
      expect(msg.payload.inventory).toEqual([
        { type: MSG_WITNESS_BLOCK, hash },
      ]);
      expect(msg.payload.inventory[0]!.type).not.toBe(MSG_BLOCK);
      await protocol.writeMessage({ command: "block", payload: genesis });
      await protocol.close();
    })();

    const opened = await openBlockSession("127.0.0.1", 8333, {
      connectTimeoutMs: 2_000,
      syncTimeoutMs: 2_000,
      connect: async () => clientSide,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error);
    const block = await opened.value.getBlock(hash);
    expect(block.transactions.length).toBe(1);
    await opened.value.close();
    await server;
  });
});
