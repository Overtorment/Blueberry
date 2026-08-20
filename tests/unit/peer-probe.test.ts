import { describe, expect, test } from "bun:test";
import {
  Networks,
  Protocol,
  answerPing,
  pairedByteDuplexes,
} from "bip324";
import { probePeer } from "../../src/net/peer-probe.ts";
import { stubDuplex } from "./stub-platform-net.ts";

async function serveHandshake(
  serverSide: Parameters<typeof Protocol.connect>[0],
  afterVerack: (protocol: Protocol) => Promise<void>,
): Promise<void> {
  const protocol = await Protocol.connect(serverSide, {
    role: "responder",
    network: Networks.mainnet,
  });
  const version = await protocol.readMessage();
  if (version.command !== "version") throw new Error("expected version");
  await protocol.writeMessage({
    command: "version",
    payload: {
      version: 70_016,
      services: 1033n,
      timestamp: BigInt(Math.floor(Date.now() / 1_000)),
      receiver: { services: 0n, ip: new Uint8Array(16), port: 8333 },
      sender: { services: 0n, ip: new Uint8Array(16), port: 0 },
      nonce: 1n,
      userAgent: "/test/",
      startHeight: 0,
      relay: false,
    },
  });
  await protocol.writeMessage({ command: "verack" });
  for (;;) {
    const msg = await protocol.readMessage();
    if (msg.command === "verack") break;
    await answerPing(protocol, msg);
  }
  await afterVerack(protocol);
}

describe("probePeer", () => {
  test("maps connect failure to ok:false", async () => {
    const result = await probePeer("1.2.3.4", 8333, {
      timeoutMs: 1000,
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
      handshakeAndGetAddr: async () => ({ peers: [], services: 0n }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  test("timeout aborts slow connect and closes duplex", async () => {
    let closed = false;
    const result = await probePeer("1.2.3.4", 8333, {
      timeoutMs: 20,
      connect: async () => {
        await new Promise((r) => setTimeout(r, 200));
        const d = stubDuplex();
        return {
          ...d,
          close: async () => {
            closed = true;
            await d.close();
          },
        };
      },
      handshakeAndGetAddr: async () => ({ peers: [], services: 0n }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timed out|aborted/);
    await new Promise((r) => setTimeout(r, 250));
    expect(closed).toBe(true);
  });

  test("succeeds after verack without waiting for getaddr", async () => {
    const [clientSide, serverSide] = pairedByteDuplexes();
    const server = serveHandshake(serverSide, async (protocol) => {
      await new Promise((r) => setTimeout(r, 50));
      await protocol.close();
    });

    const result = await probePeer("127.0.0.1", 8333, {
      timeoutMs: 2_000,
      connect: async () => clientSide,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peers).toEqual([]);
      expect(result.services).toBe(1033n);
    }
    await server;
  });

  test("wantAddr collects addrv2 after handshake and skips onion", async () => {
    const [clientSide, serverSide] = pairedByteDuplexes();
    const server = serveHandshake(serverSide, async (protocol) => {
      for (;;) {
        const msg = await protocol.readMessage();
        if (msg.command === "getaddr") break;
        await answerPing(protocol, msg);
      }
      await protocol.writeMessage({
        command: "addrv2",
        payload: {
          addresses: [
            {
              time: 1,
              services: 0n,
              networkId: 4,
              address: new Uint8Array(32),
              port: 8333,
            },
            {
              time: 1,
              services: 1033n,
              networkId: 1,
              address: Uint8Array.of(1, 2, 3, 4),
              port: 8333,
            },
            {
              time: 1,
              services: 64n,
              networkId: 1,
              address: Uint8Array.of(5, 6, 7, 8),
              port: 8333,
            },
          ],
        },
      });
      await protocol.close();
    });

    const result = await probePeer("127.0.0.1", 8333, {
      timeoutMs: 2_000,
      addrTimeoutMs: 2_000,
      wantAddr: true,
      connect: async () => clientSide,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.services).toBe(1033n);
      expect(result.peers).toEqual([
        { host: "1.2.3.4", port: 8333, services: 1033n },
        { host: "5.6.7.8", port: 8333, services: 64n },
      ]);
    }
    await server;
  });

  test("wantAddr caps a stream of one-address messages", async () => {
    const [clientSide, serverSide] = pairedByteDuplexes();
    const server = serveHandshake(serverSide, async (protocol) => {
      for (;;) {
        const msg = await protocol.readMessage();
        if (msg.command === "getaddr") break;
      }
      try {
        for (let i = 0; i < 1_005; i++) {
          await protocol.writeMessage({
            command: "addrv2",
            payload: {
              addresses: [
                {
                  time: 1,
                  services: 1n,
                  networkId: 1,
                  address: Uint8Array.of(
                    10,
                    (i >> 16) & 0xff,
                    (i >> 8) & 0xff,
                    i & 0xff,
                  ),
                  port: 8333,
                },
              ],
            },
          });
        }
      } catch {
        // The client closes after the cap.
      }
      await protocol.close();
    });

    const result = await probePeer("127.0.0.1", 8333, {
      timeoutMs: 2_000,
      addrTimeoutMs: 2_000,
      wantAddr: true,
      connect: async () => clientSide,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.peers).toHaveLength(1_000);
    await server;
  });

  test("wantAddr timeout after handshake still returns ok with empty peers", async () => {
    const [clientSide, serverSide] = pairedByteDuplexes();
    const server = serveHandshake(serverSide, async (protocol) => {
      await new Promise((r) => setTimeout(r, 200));
      await protocol.close();
    });

    const result = await probePeer("127.0.0.1", 8333, {
      timeoutMs: 2_000,
      addrTimeoutMs: 40,
      wantAddr: true,
      connect: async () => clientSide,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peers).toEqual([]);
      expect(result.services).toBe(1033n);
    }
    await server;
  });

  test("wantAddr timeout also bounds a blocked pong write", async () => {
    const [clientSide, serverSide] = pairedByteDuplexes();
    let blockWrites = false;
    const client = {
      ...clientSide,
      write(bytes: Uint8Array) {
        if (blockWrites) return new Promise<void>(() => {});
        return clientSide.write(bytes);
      },
    };
    const server = serveHandshake(serverSide, async (protocol) => {
      for (;;) {
        const msg = await protocol.readMessage();
        if (msg.command === "getaddr") break;
      }
      blockWrites = true;
      await protocol.writeMessage({
        command: "ping",
        nonce: new Uint8Array(8),
      });
      await new Promise((r) => setTimeout(r, 100));
      await protocol.close();
    });

    const result = await Promise.race([
      probePeer("127.0.0.1", 8333, {
        timeoutMs: 2_000,
        addrTimeoutMs: 40,
        wantAddr: true,
        connect: async () => client,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("probe did not respect addr timeout")), 500),
      ),
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.peers).toEqual([]);
    await server;
  });
});
