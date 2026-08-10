import { promises as dns } from "node:dns";
import { connectNodeTcp } from "bip324/node";
import type { PlatformNet } from "./types.ts";

/** Bun/Node composition-root factory. React Native supplies its own PlatformNet. */
export function createNodePlatformNet(): PlatformNet {
  return {
    connect: (host, port, signal) =>
      connectNodeTcp({ host, port }, undefined, signal),
    dns,
  };
}
