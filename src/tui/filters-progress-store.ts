import { estimateEtaMs, nextProgressSamples } from "./progress-eta.ts";

export type FiltersProgress = {
  downloaded: number;
  total: number;
  at: number | null;
  /** ms until complete; null if unknown */
  etaMs: number | null;
  percent: number; // 0..100
};

export type FiltersProgressStore = {
  get(): FiltersProgress;
  applyEvent(ev: { at: number; downloaded: number; total: number }): void;
  subscribe(listener: () => void): () => void;
};

export function createFiltersProgressStore(): FiltersProgressStore {
  let downloaded = 0;
  let total = 0;
  let at: number | null = null;
  let samples: { at: number; downloaded: number }[] = [];
  // Stable snapshot for useSyncExternalStore (Object.is); new object only on change.
  let snapshot: FiltersProgress = {
    downloaded: 0,
    total: 0,
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
      at,
      etaMs: estimateEtaMs(samples, total),
      percent,
    };
  }

  return {
    get(): FiltersProgress {
      return snapshot;
    },
    applyEvent(ev) {
      const nextSamples = nextProgressSamples(
        samples,
        { downloaded, total },
        ev,
      );
      const nextPercent =
        ev.total === 0
          ? 0
          : Math.min(100, Math.floor((100 * ev.downloaded) / ev.total));
      // Done → ETA 0 even if the sliding window still looks "in progress".
      const nextEta =
        ev.total > 0 && ev.downloaded >= ev.total
          ? 0
          : estimateEtaMs(nextSamples, ev.total);
      if (
        downloaded === ev.downloaded &&
        total === ev.total &&
        at === ev.at &&
        snapshot.etaMs === nextEta &&
        snapshot.percent === nextPercent
      ) {
        return;
      }
      downloaded = ev.downloaded;
      total = ev.total;
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
