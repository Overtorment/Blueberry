import type { EventMap, MessageBus } from "./types.ts";

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

export function createMessageBus(): MessageBus {
  const listeners = new Map<keyof EventMap, Set<Handler<keyof EventMap>>>();

  return {
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler as Handler<keyof EventMap>);
      return () => {
        set!.delete(handler as Handler<keyof EventMap>);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          (handler as (p: typeof payload) => void)(payload);
        } catch {
          // isolate subscriber failures
        }
      }
    },
  };
}
