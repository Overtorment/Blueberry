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

  test("resolves all seeds concurrently", async () => {
    const started: string[] = [];
    const release: Record<string, (hosts: string[]) => void> = {};
    const pending = resolveSeedPeers(["a", "b"], {
      port: 8333,
      resolver: {
        resolve4(host) {
          started.push(host);
          return new Promise((resolve) => {
            release[host] = resolve;
          });
        },
        async resolve6() {
          return [];
        },
      },
    });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        if (started.length === 2) return resolve();
        if (Date.now() - start > 500) {
          return reject(new Error(`only started ${started.join(",")}`));
        }
        setTimeout(tick, 5);
      };
      tick();
    });

    release.a?.(["10.0.0.1"]);
    release.b?.(["10.0.0.2"]);
    const peers = await pending;
    expect(peers.map((p) => p.host).sort()).toEqual(["10.0.0.1", "10.0.0.2"]);
  });

  test("a hanging seed does not block results from other seeds", async () => {
    const peers = await resolveSeedPeers(["hang", "ok"], {
      port: 8333,
      timeoutMs: 40,
      resolver: {
        resolve4(host) {
          if (host === "hang") return new Promise(() => {});
          return Promise.resolve(["10.0.0.2"]);
        },
        async resolve6() {
          return [];
        },
      },
    });
    expect(peers.map((p) => p.host)).toEqual(["10.0.0.2"]);
  });

  test("keeps IPv4 answers when IPv6 resolution hangs", async () => {
    const peers = await resolveSeedPeers(["mixed"], {
      port: 8333,
      timeoutMs: 40,
      resolver: {
        async resolve4() {
          return ["10.0.0.1"];
        },
        resolve6() {
          return new Promise(() => {});
        },
      },
    });
    expect(peers.map((p) => p.host)).toEqual(["10.0.0.1"]);
  });
});
