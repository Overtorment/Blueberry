import { describe, expect, test } from "bun:test";
import { NODE_COMPACT_FILTERS } from "bip157";
import { probePeer } from "../../src/net/peer-probe.ts";
import { stubDuplex } from "./stub-platform-net.ts";

describe("probePeer services", () => {
  test("returns services from injected handshake", async () => {
    const result = await probePeer("1.2.3.4", 8333, {
      timeoutMs: 500,
      connect: async () => stubDuplex(),
      handshakeAndGetAddr: async () => ({
        peers: [],
        services: BigInt(NODE_COMPACT_FILTERS),
      }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.services).toBe(BigInt(NODE_COMPACT_FILTERS));
    }
  });
});
