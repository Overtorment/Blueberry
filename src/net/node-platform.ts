import { connectNodeTcp } from "bip324/node";
import { createTorPlatformNet, torSocksPort } from "./tor-platform.ts";

/** Bun/Node composition-root factory. React Native supplies its own PlatformNet. */
export function createNodePlatformNet() {
  return createTorPlatformNet(
    (host, port, signal) => connectNodeTcp({ host, port }, undefined, signal),
    torSocksPort(process.argv),
  );
}
