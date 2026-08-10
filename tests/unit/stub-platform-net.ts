import type { ByteDuplex } from "bip324";
import type { PlatformNet } from "../../src/net/types.ts";

/** Minimal ByteDuplex for tests that never drive the BIP-324 protocol. */
export function stubDuplex(): ByteDuplex {
  return {
    async read() {
      return new Uint8Array(0);
    },
    async write() {},
    async close() {},
  };
}

/** Stub PlatformNet for module tests that inject probe/openSession/fetchBatch. */
export function stubPlatformNet(): PlatformNet {
  return {
    connect: async () => {
      throw new Error("stub PlatformNet.connect unused");
    },
    dns: {
      resolve4: async () => [],
      resolve6: async () => [],
    },
  };
}
