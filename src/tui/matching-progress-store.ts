export type MatchingProgress = {
  scanned: number;
  total: number;
  at: number | null;
  etaMs: number | null;
  percent: number;
};

export type MatchingProgressStore = {
  get(): MatchingProgress;
  applyEvent(ev: { at: number; scanned: number; total: number }): void;
  subscribe(listener: () => void): () => void;
};

/** ETA from the first real advance — ignore the TUI seed sample. */
export function createMatchingProgressStore(): MatchingProgressStore {
  let scanned = 0;
  let total = 0;
  let at: number | null = null;
  let originAt: number | null = null;
  let originScanned: number | null = null;
  let seeded = false;
  let snapshot: MatchingProgress = {
    scanned: 0,
    total: 0,
    at: null,
    etaMs: null,
    percent: 0,
  };
  const listeners = new Set<() => void>();

  function etaFor(
    nextScanned: number,
    nextTotal: number,
    nextAt: number,
  ): number | null {
    if (nextTotal > 0 && nextScanned >= nextTotal) return 0;
    if (originAt === null || originScanned === null) return null;
    if (nextScanned <= originScanned) return null;
    const dt = nextAt - originAt;
    if (dt <= 0) return null;
    const rate = (nextScanned - originScanned) / dt;
    if (rate <= 0) return null;
    return Math.round((nextTotal - nextScanned) / rate);
  }

  function publish(etaMs: number | null): void {
    const percent =
      total === 0 ? 0 : Math.min(100, Math.floor((100 * scanned) / total));
    snapshot = { scanned, total, at, etaMs, percent };
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
          : Math.min(100, Math.floor((100 * ev.scanned) / ev.total));

      const wasDone = total > 0 && scanned >= total;
      const isDone = ev.total > 0 && ev.scanned >= ev.total;

      let nextEta: number | null;
      if (isDone) {
        nextEta = 0;
        // Drop origin so a later resume does not rate across idle time.
        originAt = null;
        originScanned = null;
      } else if (!seeded) {
        nextEta = null;
        seeded = true;
      } else {
        if (ev.scanned < scanned || wasDone) {
          originAt = null;
          originScanned = null;
        }
        if (originAt === null) {
          if (ev.scanned > scanned) {
            originAt = ev.at;
            originScanned = ev.scanned;
          }
          nextEta = null;
        } else {
          nextEta = etaFor(ev.scanned, ev.total, ev.at);
        }
      }

      if (
        scanned === ev.scanned &&
        total === ev.total &&
        at === ev.at &&
        snapshot.etaMs === nextEta &&
        snapshot.percent === nextPercent
      ) {
        return;
      }
      scanned = ev.scanned;
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
