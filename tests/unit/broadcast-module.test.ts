import { describe, expect, test } from "bun:test";
import {
  Networks,
  Protocol,
  encodeTransaction,
  equalBytes,
  pairedByteDuplexes,
  transactionId,
  type ByteDuplex,
  type Transaction,
} from "bip324";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { closeFileLog } from "../../src/log.ts";
import { createBroadcastModule } from "../../src/modules/broadcast/index.ts";
import { openTempFileLog } from "./file-log-harness.ts";

function sampleTx(): Transaction {
  return {
    version: 1,
    inputs: [
      {
        previousOutput: { hash: new Uint8Array(32), index: 0 },
        scriptSig: new Uint8Array(),
        sequence: 0xffffffff,
      },
    ],
    outputs: [{ value: 1000n, scriptPubKey: Uint8Array.of(0x51) }],
    lockTime: 0,
  };
}

function upsertAlive(
  db: ReturnType<typeof createSqliteDatabase>,
  host: string,
): void {
  db.peers.upsert({
    host,
    port: 8333,
    services: 9n,
    alive: true,
    usedForBlocks: false,
    lastProbedAt: null,
  });
}

/** Accept BIP-324 session and return the received tx. */
async function acceptTx(server: ByteDuplex): Promise<Transaction> {
  const protocol = await Protocol.connect(server, {
    role: "responder",
    network: Networks.mainnet,
  });
  let gotVersion = false;
  let gotVerack = false;
  while (!gotVersion || !gotVerack) {
    const msg = await protocol.readMessage();
    if (msg.command === "version") {
      gotVersion = true;
      await protocol.writeMessage({
        command: "version",
        payload: msg.payload,
      });
      await protocol.writeMessage({ command: "verack" });
    } else if (msg.command === "verack") {
      gotVerack = true;
    }
  }
  for (;;) {
    const msg = await protocol.readMessage();
    if (msg.command === "tx") return msg.payload;
  }
}

function connectAccepting(
  received: Transaction[],
): (host: string, port: number, signal: AbortSignal) => Promise<ByteDuplex> {
  return async () => {
    const [client, server] = pairedByteDuplexes();
    void acceptTx(server)
      .then((tx) => {
        received.push(tx);
      })
      .finally(() => {
        void server.close();
      });
    return client;
  };
}

describe("broadcast module", () => {
  test("waits for an alive peer, delivers tx over BIP-324, reports ok", async () => {
    const db = createSqliteDatabase(":memory:");
    const bus = createMessageBus();
    const tx = sampleTx();
    const txHex = Buffer.from(encodeTransaction(tx)).toString("hex");
    const received: Transaction[] = [];

    const mod = createBroadcastModule(
      { bus, db },
      {
        peerWaitPollMs: 15,
        ackTimeoutMs: 150,
        connect: connectAccepting(received),
      },
    );
    await mod.start();

    const done = new Promise<{ ok: boolean; peer?: string }>((resolve) => {
      bus.on("broadcast:done", (p) => resolve(p));
    });
    bus.emit("broadcast:request", { id: "1", txHex });
    await Bun.sleep(30);
    upsertAlive(db, "9.9.9.9");

    const result = await done;
    expect(result.ok).toBe(true);
    expect(result.peer).toBe("9.9.9.9:8333");
    expect(received).toHaveLength(1);
    expect(equalBytes(transactionId(received[0]!), transactionId(tx))).toBe(
      true,
    );

    await mod.stop();
    db.close();
  });

  test("retries other alive peers after dial failure, then succeeds", async () => {
    const db = createSqliteDatabase(":memory:");
    upsertAlive(db, "1.1.1.1");
    upsertAlive(db, "2.2.2.2");
    const bus = createMessageBus();
    const tx = sampleTx();
    const txHex = Buffer.from(encodeTransaction(tx)).toString("hex");
    const received: Transaction[] = [];
    const dialed: string[] = [];

    let pick = 0;
    const mod = createBroadcastModule(
      { bus, db },
      {
        ackTimeoutMs: 150,
        // First attempt → peer[0], second → peer[1] (reuse allowed; don't stuck on one).
        random: () => (pick++ === 0 ? 0 : 0.99),
        connect: async (host, port, signal) => {
          dialed.push(host);
          if (host === "1.1.1.1") throw new Error("dial failed");
          return connectAccepting(received)(host, port, signal);
        },
      },
    );
    await mod.start();

    const done = new Promise<{ ok: boolean }>((resolve) => {
      bus.on("broadcast:done", (p) => resolve(p));
    });
    bus.emit("broadcast:request", { id: "2", txHex });

    const result = await done;
    expect(result.ok).toBe(true);
    expect(dialed).toEqual(["1.1.1.1", "2.2.2.2"]);
    expect(received).toHaveLength(1);
    expect(equalBytes(transactionId(received[0]!), transactionId(tx))).toBe(
      true,
    );

    await mod.stop();
    db.close();
  });

  test("reports failure after exhausting attempts", async () => {
    const db = createSqliteDatabase(":memory:");
    upsertAlive(db, "1.1.1.1");
    const bus = createMessageBus();
    const txHex = Buffer.from(encodeTransaction(sampleTx())).toString("hex");

    const mod = createBroadcastModule(
      { bus, db },
      {
        maxAttempts: 2,
        connect: async () => {
          throw new Error("dial failed");
        },
      },
    );
    await mod.start();

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      bus.on("broadcast:done", (p) => resolve(p));
    });
    bus.emit("broadcast:request", { id: "3", txHex });

    const result = await done;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/failed after 2 attempts/);
    expect(result.error).toMatch(/1\.1\.1\.1:8333.*dial failed/);

    await mod.stop();
    db.close();
  });

  test("cancel while waiting for alive peers", async () => {
    const db = createSqliteDatabase(":memory:");
    const bus = createMessageBus();
    let dialed = 0;
    const mod = createBroadcastModule(
      { bus, db },
      {
        peerWaitPollMs: 15,
        connect: async () => {
          dialed++;
          throw new Error("should not dial");
        },
      },
    );
    await mod.start();

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      bus.on("broadcast:done", (p) => resolve(p));
    });
    bus.emit("broadcast:request", { id: "4", txHex: Buffer.from(encodeTransaction(sampleTx())).toString("hex") });
    await Bun.sleep(25);
    bus.emit("broadcast:cancel", { id: "4" });

    const result = await done;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancel/i);
    expect(dialed).toBe(0);

    await mod.stop();
    db.close();
  });

  test("stop awaits in-flight broadcast cleanup before returning", async () => {
    const db = createSqliteDatabase(":memory:");
    upsertAlive(db, "1.1.1.1");
    const bus = createMessageBus();
    const txHex = Buffer.from(encodeTransaction(sampleTx())).toString("hex");
    let disposeDone = false;
    let dialStarted = false;
    let dialFinished = false;

    const mod = createBroadcastModule(
      { bus, db },
      {
        connect: async (_host, _port, signal) => {
          dialStarted = true;
          try {
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 200);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  reject(signal.reason ?? new Error("cancelled"));
                },
                { once: true },
              );
            });
            throw new Error("unreachable");
          } finally {
            await Bun.sleep(40);
            dialFinished = true;
          }
        },
        disposeConnect: async () => {
          disposeDone = true;
        },
      },
    );
    await mod.start();
    bus.emit("broadcast:request", { id: "5", txHex });
    await Bun.sleep(10);
    expect(dialStarted).toBe(true);

    await mod.stop();
    expect(dialFinished).toBe(true);
    expect(disposeDone).toBe(true);
    db.close();
  });

  test("cancel during the last attempt is not reported as exhausted attempts", async () => {
    const db = createSqliteDatabase(":memory:");
    upsertAlive(db, "1.1.1.1");
    const bus = createMessageBus();
    const txHex = Buffer.from(encodeTransaction(sampleTx())).toString("hex");

    const mod = createBroadcastModule(
      { bus, db },
      {
        maxAttempts: 1,
        connect: async (_host, _port, signal) => {
          await new Promise<never>((_, reject) => {
            const onAbort = () => {
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("cancelled"),
              );
            };
            if (signal.aborted) {
              onAbort();
              return;
            }
            signal.addEventListener("abort", onAbort, { once: true });
          });
          throw new Error("unreachable");
        },
      },
    );
    await mod.start();

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      bus.on("broadcast:done", (p) => resolve(p));
    });
    bus.emit("broadcast:request", { id: "6", txHex });
    await Bun.sleep(20);
    bus.emit("broadcast:cancel", { id: "6" });

    const result = await done;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cancel/i);
    expect(result.error).not.toMatch(/failed after/);

    await mod.stop();
    db.close();
  });

  test("rejects invalid tx hex without dialing", async () => {
    const db = createSqliteDatabase(":memory:");
    upsertAlive(db, "1.1.1.1");
    const bus = createMessageBus();
    let dialed = 0;

    const mod = createBroadcastModule(
      { bus, db },
      {
        connect: async () => {
          dialed++;
          throw new Error("should not dial");
        },
      },
    );
    await mod.start();

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      bus.on("broadcast:done", (p) => resolve(p));
    });
    bus.emit("broadcast:request", { id: "7", txHex: "not-hex" });

    const result = await done;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid transaction hex/i);
    expect(dialed).toBe(0);

    await mod.stop();
    db.close();
  });

  test("failed broadcast error hints to re-run with --log when file log is closed", async () => {
    closeFileLog();
    const db = createSqliteDatabase(":memory:");
    upsertAlive(db, "1.1.1.1");
    const bus = createMessageBus();
    const txHex = Buffer.from(encodeTransaction(sampleTx())).toString("hex");

    const mod = createBroadcastModule(
      { bus, db },
      {
        maxAttempts: 1,
        connect: async () => {
          throw new Error("dial failed");
        },
      },
    );
    await mod.start();

    const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      bus.on("broadcast:done", (p) => resolve(p));
    });
    bus.emit("broadcast:request", { id: "8", txHex });

    const result = await done;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/re-run with --log/);

    await mod.stop();
    db.close();
  });

  test("failed attempts write phase, timing, and unique-error logs", async () => {
    const file = openTempFileLog();
    const db = createSqliteDatabase(":memory:");
    upsertAlive(db, "1.1.1.1");
    const bus = createMessageBus();
    const tx = sampleTx();
    const txHex = Buffer.from(encodeTransaction(tx)).toString("hex");

    const mod = createBroadcastModule(
      { bus, db },
      {
        maxAttempts: 2,
        connect: async () => {
          throw new Error("dial failed");
        },
      },
    );
    await mod.start();

    const done = new Promise<{ ok: boolean }>((resolve) => {
      bus.on("broadcast:done", (p) => resolve(p));
    });
    bus.emit("broadcast:request", { id: "9", txHex });
    await done;

    const text = file.read();
    file.close();
    expect(text).toMatch(
      /\[broadcast\] start id=9 txid=[0-9a-f]{64} txHexLen=\d+ attemptBudget=2 maxAttempts=2 dialerAttempts=3 dialTimeoutMs=\d+ handshakeTimeoutMs=\d+ ackTimeoutMs=\d+/,
    );
    expect(text).toMatch(/\[broadcast\] peers-ready count=1 waitMs=\d+/);
    expect(text).toMatch(
      /\[broadcast\] attempt 1\/2 peer=1\.1\.1\.1:8333 services=9 alive=1/,
    );
    expect(text).toMatch(
      /\[broadcast\] dial start peer=1\.1\.1\.1:8333 timeoutMs=\d+/,
    );
    expect(text).toMatch(
      /\[broadcast\] dial fail peer=1\.1\.1\.1:8333 elapsedMs=\d+ timeout=false: dial failed/,
    );
    expect(text).toMatch(
      /\[broadcast\] exhausted attempts=2 unique=2× 1\.1\.1\.1:8333: dial failed/,
    );
    expect(text).toContain("[broadcast] fail-detail 1.1.1.1:8333: dial failed");
    expect(text).not.toContain(txHex);

    await mod.stop();
    db.close();
  });
});
