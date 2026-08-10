import { describe, expect, test } from "bun:test";
import {
  addrV2ToCandidate,
  legacyAddrToCandidate,
} from "../../src/net/addr.ts";

describe("addr parsing", () => {
  test("parses IPv4 addrv2 and legacy-mapped IPv4; skips onion and bad port", () => {
    expect(
      addrV2ToCandidate({
        time: 1,
        services: 1033n,
        networkId: 1,
        address: Uint8Array.of(1, 2, 3, 4),
        port: 8333,
      }),
    ).toEqual({ host: "1.2.3.4", port: 8333, services: 1033n });

    expect(
      addrV2ToCandidate({
        time: 1,
        services: 0n,
        networkId: 4,
        address: new Uint8Array(32),
        port: 8333,
      }),
    ).toBeUndefined();

    expect(
      addrV2ToCandidate({
        time: 1,
        services: 0n,
        networkId: 1,
        address: Uint8Array.of(1, 2, 3, 4),
        port: 0,
      }),
    ).toBeUndefined();

    const ip = new Uint8Array(16);
    ip.set([0xff, 0xff], 10);
    ip.set([8, 8, 8, 8], 12);
    expect(
      legacyAddrToCandidate({ time: 1, services: 1n, ip, port: 8333 }),
    ).toEqual({ host: "8.8.8.8", port: 8333, services: 1n });
  });
});
