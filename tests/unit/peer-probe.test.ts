import { describe, expect, test } from "bun:test";
import { Networks, Protocol, pairedByteDuplexes } from "bip324";
import { probePeer } from "../../src/net/peer-probe.ts";
import { stubDuplex } from "./stub-platform-net.ts";

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

    const server = (async () => {
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
      // Remain silent after verack — no addr/addrv2. Old code hung here.
      for (;;) {
        const msg = await protocol.readMessage();
        if (msg.command === "verack") break;
      }
      // Hold the socket briefly so the client can finish; never send addr.
      await new Promise((r) => setTimeout(r, 50));
      await protocol.close();
    })();

    const result = await probePeer("127.0.0.1", 8333, {
      timeoutMs: 2_000,
      connect: async () => clientSide,
      // Use real default handshake (do not inject).
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.peers).toEqual([]);
      expect(result.services).toBe(1033n);
    }
    await server;
  });
});
