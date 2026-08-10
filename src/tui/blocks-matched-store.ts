import { estimateEtaMs, nextProgressSamples } from "./progress-eta.ts";

export type BlocksProgress = {
  downloaded: number;
  matched: number;
  at: number | null;
  /** ms until complete; null if unknown */
  etaMs: number | null;
  percent: number; // 0..100
};

export type BlocksMatchedStore = {
  get(): BlocksProgress;
  applyEvent(ev: { at: number; downloaded: number; matched: number }): void;
  /** Update matched only; keep downloaded / samples. */
  setMatched(matched: number): void;
  subscribe(listener: () => void): () => void;
};

export function createBlocksMatchedStore(): BlocksMatchedStore {
  let downloaded = 0;
  let matched = 0;
  let at: number | null = null;
  let samples: { at: number; downloaded: number }[] = [];
  // Stable snapshot for useSyncExternalStore (Object.is); new object only on change.
  let snapshot: BlocksProgress = {
    downloaded: 0,
    matched: 0,
    at: null,
    etaMs: null,
    percent: 0,
  };
  const listeners = new Set<() => void>();

  function publish(
    nextDownloaded: number,
    nextMatched: number,
    nextAt: number | null,
    nextSamples: { at: number; downloaded: number }[],
  ): void {
    const nextPercent =
      nextMatched === 0
        ? 0
        : Math.min(100, Math.floor((100 * nextDownloaded) / nextMatched));
    const nextEta =
      nextMatched > 0 && nextDownloaded >= nextMatched
        ? 0
        : estimateEtaMs(nextSamples, nextMatched);
    if (
      downloaded === nextDownloaded &&
      matched === nextMatched &&
      at === nextAt &&
      snapshot.etaMs === nextEta &&
      snapshot.percent === nextPercent
    ) {
      return;
    }
    downloaded = nextDownloaded;
    matched = nextMatched;
    at = nextAt;
    samples = nextSamples;
    snapshot = {
      downloaded,
      matched,
      at,
      etaMs: nextEta,
      percent: nextPercent,
    };
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      return snapshot;
    },
    applyEvent(ev) {
      const nextSamples = nextProgressSamples(
        samples,
        { downloaded, total: matched },
        {
          at: ev.at,
          downloaded: ev.downloaded,
          total: ev.matched,
        },
      );
      publish(ev.downloaded, ev.matched, ev.at, nextSamples);
    },
    setMatched(nextMatched) {
      const nextSamples =
        at === null
          ? samples
          : nextProgressSamples(
              samples,
              { downloaded, total: matched },
              { at, downloaded, total: nextMatched },
            );
      publish(downloaded, nextMatched, at, nextSamples);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
