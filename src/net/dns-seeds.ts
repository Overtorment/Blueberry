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

const DEFAULT_SEED_TIMEOUT_MS = 3_000;

async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return task;
  return await new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

async function resolveFamily(
  task: Promise<string[]>,
  timeoutMs: number,
): Promise<string[]> {
  return withTimeout(
    Promise.resolve(task).catch(() => [] as string[]),
    timeoutMs,
    [],
  );
}

export async function resolveSeedPeers(
  seeds: readonly string[],
  options: {
    port: number;
    resolver: DnsResolver;
    random?: () => number;
    timeoutMs?: number;
  },
): Promise<PeerCandidate[]> {
  const random = options.random ?? Math.random;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEED_TIMEOUT_MS;
  const resolved = await Promise.all(
    seeds.map(async (seed) => {
      const [a, b] = await Promise.all([
        resolveFamily(options.resolver.resolve4(seed), timeoutMs),
        resolveFamily(options.resolver.resolve6(seed), timeoutMs),
      ]);
      return { v4: a, v6: b };
    }),
  );
  const v4: PeerCandidate[] = [];
  const v6: PeerCandidate[] = [];
  for (const { v4: a, v6: b } of resolved) {
    for (const host of a) {
      v4.push({ host, port: options.port, services: 0n });
    }
    for (const host of b) {
      v6.push({ host, port: options.port, services: 0n });
    }
  }
  return [...shuffleInPlace(v4, random), ...shuffleInPlace(v6, random)];
}
