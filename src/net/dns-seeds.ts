export const MAINNET_DNS_SEEDS = Object.freeze([
  "seed.bitcoin.sipa.be",
  "dnsseed.bluematt.me",
  "seed.bitcoin.jonasschnelli.ch",
  "seed.btc.petertodd.net",
  "seed.bitcoin.sprovoost.nl",
  "dnsseed.emzy.de",
  "seed.bitcoin.wiz.biz",
]);

export type PeerCandidate = {
  host: string;
  port: number;
  services: bigint;
};

export type DnsResolver = {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
};

function shuffleInPlace<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
  return items;
}

export async function resolveSeedPeers(
  seeds: readonly string[],
  options: {
    port: number;
    resolver: DnsResolver;
    random?: () => number;
  },
): Promise<PeerCandidate[]> {
  const random = options.random ?? Math.random;
  const v4: PeerCandidate[] = [];
  const v6: PeerCandidate[] = [];
  for (const seed of seeds) {
    try {
      const [a, b] = await Promise.all([
        options.resolver.resolve4(seed).catch(() => [] as string[]),
        options.resolver.resolve6(seed).catch(() => [] as string[]),
      ]);
      for (const host of a) {
        v4.push({ host, port: options.port, services: 0n });
      }
      for (const host of b) {
        v6.push({ host, port: options.port, services: 0n });
      }
    } catch {
      // ignore whole-seed failures
    }
  }
  return [...shuffleInPlace(v4, random), ...shuffleInPlace(v6, random)];
}
