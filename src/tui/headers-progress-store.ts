import { estimateEtaMs, nextProgressSamples } from "./progress-eta.ts";

export type HeadersProgress = {
  downloaded: number;
  total: number;
  /** Absolute chain tip height; 0 if unknown. */
  height: number;
  at: number | null;
  /** ms until complete; null if unknown */
  etaMs: number | null;
  percent: number; // 0..100
};

export type HeadersProgressStore = {
  get(): HeadersProgress;
  applyEvent(ev: {
    at: number;
    downloaded: number;
    total: number;
    height: number;
  }): void;
  subscribe(listener: () => void): () => void;
};

export function createHeadersProgressStore(): HeadersProgressStore {
  let downloaded = 0;
  let total = 0;
  let height = 0;
  let at: number | null = null;
  let samples: { at: number; downloaded: number }[] = [];
  // Stable snapshot for useSyncExternalStore (Object.is); new object only on change.
  let snapshot: HeadersProgress = {
    downloaded: 0,
    total: 0,
    height: 0,
    at: null,
    etaMs: null,
    percent: 0,
  };
  const listeners = new Set<() => void>();

  function refreshSnapshot(): void {
    const percent =
      total === 0 ? 0 : Math.min(100, Math.floor((100 * downloaded) / total));
    snapshot = {
      downloaded,
      total,
      height,
      at,
      etaMs: estimateEtaMs(samples, total),
      percent,
    };
  }

  return {
    get(): HeadersProgress {
      return snapshot;
    },
    applyEvent(ev) {
      const nextHeight = Math.max(0, Math.floor(ev.height));
      const nextSamples = nextProgressSamples(
        samples,
        { downloaded, total },
        {
          at: ev.at,
          downloaded: ev.downloaded,
          total: ev.total,
        },
      );
      const nextPercent =
        ev.total === 0
          ? 0
          : Math.min(100, Math.floor((100 * ev.downloaded) / ev.total));
      const nextEta =
        ev.total > 0 && ev.downloaded >= ev.total
          ? 0
          : estimateEtaMs(nextSamples, ev.total);
      if (
        downloaded === ev.downloaded &&
        total === ev.total &&
        height === nextHeight &&
        at === ev.at &&
        snapshot.etaMs === nextEta &&
        snapshot.percent === nextPercent
      ) {
        return;
      }
      downloaded = ev.downloaded;
      total = ev.total;
      height = nextHeight;
      at = ev.at;
      samples = nextSamples;
      refreshSnapshot();
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
