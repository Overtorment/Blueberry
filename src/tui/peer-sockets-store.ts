import type { PeerSocketKind } from "../bus/types.ts";

export type PeerSocketCounts = Record<PeerSocketKind, number> & {
  known: number;
};

export type PeerSocketsStore = {
  get(): PeerSocketCounts;
  setKnown(known: number): void;
  applyEvent(ev: { kind: PeerSocketKind; open: number }): void;
  subscribe(listener: () => void): () => void;
};

const ZERO: PeerSocketCounts = {
  known: 0,
  probe: 0,
  hdr: 0,
  filt: 0,
  blk: 0,
};

export function formatPeerSockets(counts: PeerSocketCounts): string {
  return `probe ${counts.probe} · hdr ${counts.hdr} · filt ${counts.filt} · blk ${counts.blk}`;
}

export function createPeerSocketsStore(): PeerSocketsStore {
  let snapshot: PeerSocketCounts = { ...ZERO };
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      return snapshot;
    },
    setKnown(known) {
      const next = Math.max(0, Math.floor(known));
      if (snapshot.known === next) return;
      snapshot = { ...snapshot, known: next };
      notify();
    },
    applyEvent(ev) {
      const open = Math.max(0, Math.floor(ev.open));
      if (snapshot[ev.kind] === open) return;
      snapshot = { ...snapshot, [ev.kind]: open };
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
