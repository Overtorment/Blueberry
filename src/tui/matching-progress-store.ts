export type MatchingProgress = {
  matched: number;
  total: number;
  at: number | null;
  etaMs: number | null;
  percent: number;
};

export type MatchingProgressStore = {
  get(): MatchingProgress;
  applyEvent(ev: { at: number; matched: number; total: number }): void;
  subscribe(listener: () => void): () => void;
};

/** ETA from the first real advance — ignore the TUI seed sample. */
export function createMatchingProgressStore(): MatchingProgressStore {
  let matched = 0;
  let total = 0;
  let at: number | null = null;
  let originAt: number | null = null;
  let originMatched: number | null = null;
  let seeded = false;
  let snapshot: MatchingProgress = {
    matched: 0,
    total: 0,
    at: null,
    etaMs: null,
    percent: 0,
  };
  const listeners = new Set<() => void>();

  function etaFor(
    nextMatched: number,
    nextTotal: number,
    nextAt: number,
  ): number | null {
    if (nextTotal > 0 && nextMatched >= nextTotal) return 0;
    if (originAt === null || originMatched === null) return null;
    if (nextMatched <= originMatched) return null;
    const dt = nextAt - originAt;
    if (dt <= 0) return null;
    const rate = (nextMatched - originMatched) / dt;
    if (rate <= 0) return null;
    return Math.round((nextTotal - nextMatched) / rate);
  }

  function publish(etaMs: number | null): void {
    const percent =
      total === 0 ? 0 : Math.min(100, Math.floor((100 * matched) / total));
    snapshot = { matched, total, at, etaMs, percent };
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      return snapshot;
    },
    applyEvent(ev) {
      const nextPercent =
        ev.total === 0
          ? 0
          : Math.min(100, Math.floor((100 * ev.matched) / ev.total));

      const wasDone = total > 0 && matched >= total;
      const isDone = ev.total > 0 && ev.matched >= ev.total;

      let nextEta: number | null;
      if (isDone) {
        nextEta = 0;
        // Drop origin so a later resume does not rate across idle time.
        originAt = null;
        originMatched = null;
      } else if (!seeded) {
        nextEta = null;
        seeded = true;
      } else {
        if (ev.matched < matched || wasDone) {
          originAt = null;
          originMatched = null;
        }
        if (originAt === null) {
          if (ev.matched > matched) {
            originAt = ev.at;
            originMatched = ev.matched;
          }
          nextEta = null;
        } else {
          nextEta = etaFor(ev.matched, ev.total, ev.at);
        }
      }

      if (
        matched === ev.matched &&
        total === ev.total &&
        at === ev.at &&
        snapshot.etaMs === nextEta &&
        snapshot.percent === nextPercent
      ) {
        return;
      }
      matched = ev.matched;
      total = ev.total;
      at = ev.at;
      publish(nextEta);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
