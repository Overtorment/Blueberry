import { describe, expect, test } from "bun:test";
import { torStreamToByteDuplex } from "../../src/modules/broadcast/tor-byte-duplex.ts";

/** In-memory TorStream-shaped pair: readable yields `chunks`, writable records writes. */
function fakeTorStream(chunks: Uint8Array[]) {
  const written: Uint8Array[] = [];
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(chunk);
      c.close();
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(chunk.slice());
    },
  });
  return {
    stream: {
      outer: { readable, writable },
      close: () => {
        closed = true;
      },
    },
    written,
    isClosed: () => closed,
  };
}

describe("torStreamToByteDuplex", () => {
  test("reads across stream chunks; write reaches the tor side", async () => {
    const { stream, written } = fakeTorStream([
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(4, 5),
    ]);
    const duplex = torStreamToByteDuplex(stream);

    // ByteDuplex: read(n) may return fewer than n (drain buffer first).
    expect([...(await duplex.read(2))]).toEqual([1, 2]);
    expect([...(await duplex.read(2))]).toEqual([3]);
    expect([...(await duplex.read(2))]).toEqual([4, 5]);

    await duplex.write(Uint8Array.of(9, 8));
    expect([...written[0]!]).toEqual([9, 8]);
  });

  test("EOF and close yield empty reads", async () => {
    const { stream, isClosed } = fakeTorStream([Uint8Array.of(7)]);
    const duplex = torStreamToByteDuplex(stream);

    expect([...(await duplex.read(1))]).toEqual([7]);
    expect((await duplex.read(1)).length).toBe(0);

    await duplex.close();
    expect(isClosed()).toBe(true);
    expect((await duplex.read(4)).length).toBe(0);
  });
});
