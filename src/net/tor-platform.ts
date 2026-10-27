import { randomBytes } from "node:crypto";
import type { ByteDuplex } from "bip324";
import { MAINNET_DNS_SEEDS } from "./dns-seeds.ts";
import type { PlatformNet, TcpConnect } from "./types.ts";

async function readExactly(io: ByteDuplex, length: number): Promise<Uint8Array> {
  const result = new Uint8Array(length);
  let offset = 0;
  while (offset < length) {
    const chunk = await io.read(length - offset);
    if (chunk.length === 0 || chunk.length > length - offset) throw new Error("Truncated Tor SOCKS reply");
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** SOCKS5 hostnames are passed to Tor unchanged; never resolve a destination locally. */
async function negotiate(io: ByteDuplex, host: string, port: number, isolation: string): Promise<void> {
  const name = new TextEncoder().encode(host);
  if (!/^[a-zA-Z0-9._:-]+$/.test(host) || name.length > 255 || name.length === 0) throw new Error("Invalid peer hostname");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid peer port");
  // Require SOCKS credentials to request separate Tor circuits for sync and broadcast.
  await io.write(Uint8Array.of(5, 1, 2));
  const method = await readExactly(io, 2);
  if (method[0] !== 5 || method[1] !== 2) throw new Error("Tor SOCKS proxy must support stream-isolation credentials");
  const user = new TextEncoder().encode(isolation);
  await io.write(Uint8Array.from([1, user.length, ...user, 1, 120]));
  const auth = await readExactly(io, 2);
  if (auth[0] !== 1 || auth[1] !== 0) throw new Error("Tor SOCKS authentication failed");
  await io.write(Uint8Array.from([5, 1, 0, 3, name.length, ...name, port >> 8, port & 255]));
  const reply = await readExactly(io, 4);
  if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error("Tor refused the peer connection");
  const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readExactly(io, 1))[0]! : 0;
  if (addressLength === 0) throw new Error("Invalid Tor SOCKS address reply");
  await readExactly(io, addressLength + 2);
}

export function torSocksPort(argv: readonly string[]): number {
  const flags = argv.filter((arg) => arg.startsWith("--tor-socks-port="));
  if (flags.length > 1) throw new Error("Specify the Tor SOCKS port only once");
  if (flags.length === 0) return 9050;
  const value = flags[0]!.slice("--tor-socks-port=".length);
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Tor SOCKS port");
  return port;
}

export function createTorPlatformNet(connectProxy: TcpConnect, proxyPort = 9050) {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error("Invalid Tor SOCKS port");
  const session = randomBytes(16).toString("hex");

  function connector(scope: "sync" | "broadcast"): TcpConnect {
    return async (host, port, signal) => {
      const deadline = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000);
      deadline.throwIfAborted();
      let io: ByteDuplex | undefined;
      let onAbort: () => void;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          void io?.close().catch(() => {});
          reject(deadline.reason);
        };
        deadline.addEventListener("abort", onAbort, { once: true });
      });
      const pending = (async () => {
        try {
          // This is the only TCP destination opened by the platform adapter.
          io = await connectProxy("127.0.0.1", proxyPort, deadline);
          deadline.throwIfAborted();
          await negotiate(io, host, port, `blueberry-${scope}-${session}`);
          deadline.throwIfAborted();
          return io;
        } catch (err) {
          await io?.close().catch(() => {});
          throw err;
        }
      })();
      try {
        return await Promise.race([pending, aborted]);
      } catch (err) {
        // Also close a proxy connection which finishes after cancellation.
        void pending.then((late) => late.close()).catch(() => {});
        await io?.close().catch(() => {});
        const reason = err instanceof Error ? err.message : "proxy or SOCKS negotiation failed";
        throw new Error(`Tor connection failed via 127.0.0.1:${proxyPort}; direct networking is disabled (${reason})`, { cause: err });
      } finally {
        deadline.removeEventListener("abort", onAbort!);
      }
    };
  }

  const disabledDns = async (): Promise<string[]> => {
    throw new Error("Local DNS is disabled; Tor resolves destination hostnames");
  };
  const net: PlatformNet = {
    connect: connector("sync"),
    dns: { resolve4: disabledDns, resolve6: disabledDns },
  };
  return {
    ...net,
    connectBroadcast: connector("broadcast"),
    // DNS seeds are also hostnames of Bitcoin peers. Tor selects their IPs remotely;
    // subsequent getaddr crawling discovers additional peers through the tunnel.
    resolveSeeds: async () => MAINNET_DNS_SEEDS.map((host) => ({ host, port: 8333, services: 0n })),
  };
}
