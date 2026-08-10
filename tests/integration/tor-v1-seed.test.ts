/**
 * Live integration: echalote Tor exit → mainnet DNS seed peer → Bitcoin P2P v1
 * version/verack. Run with `bun run test:integration`.
 */
import { describe, expect, test } from "bun:test";
import { promises as dns } from "node:dns";
import type { ByteDuplex } from "bip324";
import { APP_NAME, APP_VERSION } from "../../src/net/user-agent.ts";
import {
  MAINNET_DNS_SEEDS,
  resolveSeedPeers,
} from "../../src/net/dns-seeds.ts";
import {
  NotV1PeerError,
  completeV1VersionHandshake,
  isSanePeerVersion,
} from "../../src/net/v1-p2p.ts";
import { withTorDialRetries } from "../../src/modules/broadcast/tor-dial-policy.ts";
import { createTorByteDuplexDialer } from "../../src/modules/broadcast/tor-byte-duplex.ts";

const OVERALL_MS = 300_000;
const CYCLE_MS = 90_000;
const PER_PEER_MS = 30_000;
const MAX_PEERS = 20;
const DIALER_ATTEMPTS = 3;
const PORT = 8333;

describe("integration: Tor exit Bitcoin P2P v1", () => {
  test(
    "echalote dials a seed peer and completes a sane v1 version handshake",
    async () => {
      const overall = AbortSignal.timeout(OVERALL_MS);
      const peers = await resolveSeedPeers(MAINNET_DNS_SEEDS, {
        port: PORT,
        resolver: dns,
      });
      expect(peers.length).toBeGreaterThan(0);

      const errors: string[] = [];

      await withTorDialRetries(
        () => createTorByteDuplexDialer(),
        async (dial, signal) => {
          const cycle = AbortSignal.any([
            signal,
            AbortSignal.timeout(CYCLE_MS),
          ]);
          for (const peer of peers.slice(0, MAX_PEERS)) {
            if (cycle.aborted) break;
            const peerSignal = AbortSignal.any([
              cycle,
              AbortSignal.timeout(PER_PEER_MS),
            ]);
            let duplex: ByteDuplex | undefined;
            try {
              duplex = (await dial(
                peer.host,
                peer.port,
                peerSignal,
              )) as ByteDuplex;
              const result = await completeV1VersionHandshake(duplex, {
                port: peer.port,
                name: APP_NAME,
                version: APP_VERSION,
              });
              expect(isSanePeerVersion(result)).toBe(true);
              expect(result.userAgent.length).toBeGreaterThan(0);
              expect(result.services).not.toBe(0n);
              expect(result.startHeight).toBeGreaterThan(0);
              return true;
            } catch (err) {
              const msg =
                err instanceof NotV1PeerError
                  ? `not-v1 ${peer.host}: ${err.message}`
                  : err instanceof Error
                    ? `${peer.host}: ${err.message}`
                    : `${peer.host}: ${String(err)}`;
              errors.push(msg);
            } finally {
              try {
                await duplex?.close();
              } catch {
                // ignore
              }
            }
          }
          throw new Error(
            `no v1 peer succeeded after ${errors.length} attempts: ${errors.slice(0, 5).join("; ")}`,
          );
        },
        {
          attempts: DIALER_ATTEMPTS,
          backoffMs: 1_500,
          signal: overall,
        },
      );
    },
    OVERALL_MS + 30_000,
  );
});
