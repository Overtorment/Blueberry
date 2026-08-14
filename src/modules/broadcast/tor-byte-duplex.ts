/**
 * Adapter: echalote `Echalote.createExitDialer` → bip324 `ByteDuplex`.
 */
import type { ByteDuplex } from "bip324";
import {
  createExitDialer,
  type ExitDialerOptions,
} from "./echalote.ts";

export type TorByteDuplexDialer = {
  dial: (
    host: string,
    port: number,
    signal: AbortSignal,
  ) => Promise<ByteDuplex>;
  dispose: () => Promise<void>;
};

export type TorByteDuplexDialerOptions = ExitDialerOptions;

export function torStreamToByteDuplex(stream: {
  outer: ReadableWritablePair<Uint8Array, Uint8Array>;
  close: () => void;
}): ByteDuplex {
  const reader = stream.outer.readable.getReader();
  const writer = stream.outer.writable.getWriter();
  let buffer = new Uint8Array(0);
  let closed = false;

  const take = (n: number): Uint8Array | undefined => {
    if (buffer.length === 0) return undefined;
    if (buffer.length <= n) {
      const out = buffer;
      buffer = new Uint8Array(0);
      return out;
    }
    const out = buffer.slice(0, n);
    buffer = buffer.subarray(n);
    return out;
  };

  return {
    async read(n) {
      if (closed) return new Uint8Array(0);
      for (;;) {
        const buffered = take(n);
        if (buffered) return buffered;
        let value: Uint8Array | undefined;
        let done = false;
        try {
          const result = await reader.read();
          value = result.value;
          done = result.done;
        } catch {
          closed = true;
          return new Uint8Array(0);
        }
        if (done) {
          closed = true;
          return new Uint8Array(0);
        }
        if (!value || value.length === 0) continue;
        const next = new Uint8Array(buffer.length + value.length);
        next.set(buffer);
        next.set(value, buffer.length);
        buffer = next;
      }
    },
    async write(bytes) {
      await writer.write(bytes.slice());
    },
    async close() {
      closed = true;
      try {
        await writer.close();
      } catch {
        // ignore
      }
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      try {
        stream.close();
      } catch {
        // ignore
      }
    },
  };
}

export function createTorByteDuplexDialer(
  options: TorByteDuplexDialerOptions = {},
): TorByteDuplexDialer {
  const dialer = createExitDialer(options);
  return {
    async dial(host, port, signal) {
      const stream = await dialer.dial(host, port, signal);
      return torStreamToByteDuplex(stream);
    },
    dispose: () => dialer.dispose(),
  };
}
