/** Live Tor SOCKS -> remotely resolved Bitcoin seed -> encrypted BIP-324 handshake. No transactions. */
import { expect, test } from "bun:test";
import { createNodePlatformNet } from "../../src/net/node-platform.ts";
import { probePeer } from "../../src/net/peer-probe.ts";

test("Tor-only transport reaches a Bitcoin peer without local DNS", async () => {
  const net = createNodePlatformNet();
  const peers = await net.resolveSeeds();
  const errors: string[] = [];
  for (const peer of peers) {
    const result = await probePeer(peer.host, peer.port, {
      connect: net.connect,
      timeoutMs: 45_000,
      addrTimeoutMs: 5_000,
      wantAddr: true,
    });
    if (result.ok) {
      expect(result.services).not.toBe(0n);
      return;
    }
    errors.push(`${peer.host}: ${result.error}`);
  }
  throw new Error(`No Tor Bitcoin handshake succeeded. Check Tor SOCKS reachability from this test process. ${errors.join("; ")}`);
}, 360_000);
