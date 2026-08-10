import { describe, expect, test } from "bun:test";
import { resolveSeedPeers } from "../../src/net/dns-seeds.ts";

describe("dns-seeds", () => {
  test("resolveSeedPeers returns IPv4 before IPv6 with given port", async () => {
    const peers = await resolveSeedPeers(["seed.example"], {
      port: 8333,
      resolver: {
        async resolve4() {
          return ["10.0.0.1"];
        },
        async resolve6() {
          return ["2001:db8::1"];
        },
      },
      random: () => 0,
    });
    expect(peers.map((p) => p.host)).toEqual(["10.0.0.1", "2001:db8::1"]);
    expect(peers.every((p) => p.port === 8333)).toBe(true);
  });

  test("skips seeds whose resolver throws", async () => {
    const peers = await resolveSeedPeers(["bad", "good"], {
      port: 8333,
      resolver: {
        async resolve4(host) {
          if (host === "bad") throw new Error("fail");
          return ["9.9.9.9"];
        },
        async resolve6() {
          return [];
        },
      },
    });
    expect(peers.map((p) => p.host)).toEqual(["9.9.9.9"]);
  });
});
