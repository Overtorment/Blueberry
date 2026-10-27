import assert from "node:assert/strict";
import { test } from "node:test";
import { createTorPlatformNet, torSocksPort } from "../../src/net/tor-platform.ts";

const REPLY = [5, 2, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0];
function stream(bytes = REPLY) {
  const incoming = [...bytes];
  const writes = [];
  let closed = false;
  let waiting;
  return {
    writes,
    get closed() { return closed; },
    async read(n) {
      if (incoming.length) return Uint8Array.of(incoming.shift()); // fragment every byte
      if (closed) return new Uint8Array();
      return new Promise((resolve) => { waiting = resolve; });
    },
    async write(bytes) { writes.push([...bytes]); },
    async close() { closed = true; waiting?.(new Uint8Array()); },
  };
}

test("sync tunnels only to loopback Tor, delegates hostname resolution, and preserves payload bytes", async () => {
  const io = stream([...REPLY, 42]);
  const calls = [];
  const net = createTorPlatformNet(async (...args) => { calls.push(args); return io; });
  const tunnel = await net.connect("seed.bitcoin.sipa.be", 8333);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["127.0.0.1", 9050]);
  assert.deepEqual(io.writes[0], [5, 1, 2]);
  const request = io.writes[2];
  assert.deepEqual(request.slice(0, 5), [5, 1, 0, 3, 20]);
  assert.equal(new TextDecoder().decode(Uint8Array.from(request.slice(5, -2))), "seed.bitcoin.sipa.be");
  assert.deepEqual(request.slice(-2), [32, 141]);
  assert.deepEqual(await tunnel.read(1), Uint8Array.of(42));
  await tunnel.close();
});

test("bootstrap performs no DNS or TCP call and local DNS fails closed", async () => {
  let calls = 0;
  const net = createTorPlatformNet(async () => { calls++; throw new Error("offline"); });
  const peers = await net.resolveSeeds();
  assert.equal(peers.length, 7);
  assert.ok(peers.every((p) => p.port === 8333 && p.host.includes(".")));
  await assert.rejects(net.dns.resolve4("example.org"), /Local DNS is disabled/);
  await assert.rejects(net.dns.resolve6("example.org"), /Local DNS is disabled/);
  assert.equal(calls, 0);
});

test("Tor outage never retries a direct peer connection", async () => {
  const calls = [];
  const net = createTorPlatformNet(async (...args) => { calls.push(args); throw new Error("proxy unavailable"); });
  await assert.rejects(net.connect("203.0.113.10", 8333), /direct networking is disabled/);
  await assert.rejects(net.connectBroadcast("203.0.113.10", 8333), /direct networking is disabled/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((args) => args[0] === "127.0.0.1" && args[1] === 9050));
});

test("sync and broadcast request different Tor stream-isolation credentials", async () => {
  const streams = [];
  const net = createTorPlatformNet(async () => { const io = stream(); streams.push(io); return io; });
  await (await net.connect("203.0.113.10", 8333)).close();
  await (await net.connectBroadcast("203.0.113.10", 8333)).close();
  assert.notDeepEqual(streams[0].writes[1], streams[1].writes[1]);
});

test("proxy method, authentication, and CONNECT failures close the connection", async () => {
  for (const reply of [[5, 0], [5, 2, 1, 1], [5, 2, 1, 0, 5, 5, 0, 1]]) {
    const io = stream(reply);
    const net = createTorPlatformNet(async () => io);
    await assert.rejects(net.connect("203.0.113.10", 8333), /Tor connection failed/);
    assert.equal(io.closed, true);
  }
});

test("a stalled SOCKS negotiation is cancellable", async () => {
  const io = stream([]);
  const net = createTorPlatformNet(async () => io);
  const abort = new AbortController();
  const pending = net.connect("203.0.113.10", 8333, abort.signal);
  abort.abort(new Error("fixture cancellation"));
  await assert.rejects(pending, /Tor connection failed/);
  assert.equal(io.closed, true);
});

test("a proxy connection which completes after cancellation is closed", async () => {
  const io = stream();
  let finish;
  const net = createTorPlatformNet(() => new Promise((resolve) => { finish = resolve; }));
  const abort = new AbortController();
  const pending = net.connect("203.0.113.10", 8333, abort.signal);
  abort.abort();
  await assert.rejects(pending, /Tor connection failed/);
  finish(io);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(io.closed, true);
});

test("proxy port configuration is numeric, unambiguous, and bounded", () => {
  assert.equal(torSocksPort([]), 9050);
  assert.equal(torSocksPort(["--tor-socks-port=9150"]), 9150);
  for (const value of ["0", "65536", "localhost:9050", "", "9050x"]) {
    assert.throws(() => torSocksPort(["--tor-socks-port=" + value]), /Invalid/);
  }
  assert.throws(() => torSocksPort(["--tor-socks-port=9050", "--tor-socks-port=9150"]), /only once/);
});
