export type BroadcastUiPhase =
  | "idle"
  | "waiting-peers"
  | "attempt"
  | "success"
  | "error";

export type BroadcastUiSnapshot = {
  id: string | null;
  phase: BroadcastUiPhase;
  attempt: number | null;
  maxAttempts: number | null;
  peer: string | null;
  detail: string | null;
  error: string | null;
};

const idle: BroadcastUiSnapshot = {
  id: null,
  phase: "idle",
  attempt: null,
  maxAttempts: null,
  peer: null,
  detail: null,
  error: null,
};

export type BroadcastStore = {
  get(): BroadcastUiSnapshot;
  subscribe(listener: () => void): () => void;
  reset(): void;
  /** Mark in-flight immediately so Esc can cancel before the first progress event. */
  begin(id: string): void;
  applyProgress(payload: {
    id: string;
    phase: string;
    attempt?: number;
    maxAttempts?: number;
    peer?: string;
    detail?: string;
  }): void;
  applyDone(
    payload:
      | { id: string; ok: true; peer: string }
      | { id: string; ok: false; error: string },
  ): void;
};

export function createBroadcastStore(): BroadcastStore {
  let snap: BroadcastUiSnapshot = { ...idle };
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const l of listeners) l();
  }

  return {
    get: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      snap = { ...idle };
      emit();
    },
    begin(id) {
      snap = {
        ...idle,
        id,
        phase: "waiting-peers",
      };
      emit();
    },
    applyProgress(payload) {
      if (snap.id && snap.id !== payload.id) return;
      const phase =
        payload.phase === "waiting-peers" ||
        payload.phase === "attempt" ||
        payload.phase === "error"
          ? payload.phase
          : payload.phase === "failed-attempt"
            ? "attempt"
            : snap.phase;
      snap = {
        id: payload.id,
        phase,
        attempt: payload.attempt ?? snap.attempt,
        maxAttempts: payload.maxAttempts ?? snap.maxAttempts,
        peer: payload.peer ?? snap.peer,
        detail: payload.detail ?? null,
        error: null,
      };
      emit();
    },
    applyDone(payload) {
      if (snap.id && snap.id !== payload.id) return;
      if (payload.ok) {
        snap = {
          id: payload.id,
          phase: "success",
          attempt: snap.attempt,
          maxAttempts: snap.maxAttempts,
          peer: payload.peer,
          detail: `Sent via ${payload.peer}`,
          error: null,
        };
      } else {
        snap = {
          id: payload.id,
          phase: "error",
          attempt: snap.attempt,
          maxAttempts: snap.maxAttempts,
          peer: snap.peer,
          detail: null,
          error: payload.error,
        };
      }
      emit();
    },
  };
}
