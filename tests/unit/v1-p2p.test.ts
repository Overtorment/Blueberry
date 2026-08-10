import { describe, expect, test } from "bun:test";
import {
  Networks,
  encodeVersion,
  pairedByteDuplexes,
  sha256d,
  type VersionPayload,
} from "bip324";
import {
  NotV1PeerError,
  completeV1VersionHandshake,
  decodeV1Frame,
  encodeV1Frame,
  isSanePeerVersion,
  readV1Message,
  writeV1Message,
} from "../../src/net/v1-p2p.ts";

const MAGIC = Networks.mainnet.magic;

function sampleVersion(overrides: Partial<VersionPayload> = {}): VersionPayload {
  return {
    version: 70_016,
    services: 1033n,
    timestamp: 1_700_000_000n,
    receiver: { services: 0n, ip: new Uint8Array(16), port: 8333 },
    sender: { services: 0n, ip: new Uint8Array(16), port: 0 },
    nonce: 42n,
    userAgent: "/test:1.0.0/",
    startHeight: 800_000,
    relay: false,
    ...overrides,
  };
}

describe("v1 P2P framing", () => {
  test("round-trips version payload with magic, command, checksum", () => {
    const payload = encodeVersion(sampleVersion());
    const frame = encodeV1Frame(MAGIC, "version", payload);
    expect(frame.subarray(0, 4)).toEqual(MAGIC);
    expect(new TextDecoder().decode(frame.subarray(4, 16)).replace(/\0+$/, "")).toBe(
      "version",
    );
    const length = new DataView(frame.buffer, frame.byteOffset + 16, 4).getUint32(
      0,
      true,
    );
    expect(length).toBe(payload.length);
    expect(frame.subarray(20, 24)).toEqual(sha256d(payload).subarray(0, 4));
    expect(frame.subarray(24)).toEqual(payload);

    const decoded = decodeV1Frame(frame, MAGIC);
    expect(decoded.command).toBe("version");
    expect(decoded.payload).toEqual(payload);
  });

  test("decode rejects wrong magic", () => {
    const frame = encodeV1Frame(MAGIC, "verack", new Uint8Array(0));
    frame[0] = 0;
    expect(() => decodeV1Frame(frame, MAGIC)).toThrow(NotV1PeerError);
  });

  test("decode rejects bad checksum", () => {
    const frame = encodeV1Frame(MAGIC, "verack", new Uint8Array(0));
    frame[20] ^= 1;
    expect(() => decodeV1Frame(frame, MAGIC)).toThrow(/checksum/);
  });
});

describe("v1 P2P stream + handshake", () => {
  test("read/write message over ByteDuplex", async () => {
    const [a, b] = pairedByteDuplexes();
    const payload = encodeVersion(sampleVersion());
    await writeV1Message(a, MAGIC, "version", payload);
    const msg = await readV1Message(b, MAGIC);
    expect(msg.command).toBe("version");
    expect(msg.payload).toEqual(payload);
  });

  test("readV1Message throws NotV1PeerError when peer is not v1", async () => {
    const [a, b] = pairedByteDuplexes();
    await a.write(Uint8Array.of(1, 2, 3, 4));
    await expect(readV1Message(b, MAGIC)).rejects.toBeInstanceOf(NotV1PeerError);
  });

  test("completeV1VersionHandshake exchanges version/verack", async () => {
    const [client, server] = pairedByteDuplexes();

    const peer = (async () => {
      const theirs = await readV1Message(server, MAGIC);
      expect(theirs.command).toBe("version");
      await writeV1Message(
        server,
        MAGIC,
        "version",
        encodeVersion(
          sampleVersion({
            userAgent: "/Satoshi:26.0.0/",
            services: 1033n,
            startHeight: 850_000,
          }),
        ),
      );
      await writeV1Message(server, MAGIC, "verack", new Uint8Array(0));
      const verack = await readV1Message(server, MAGIC);
      expect(verack.command).toBe("verack");
    })();

    const result = await completeV1VersionHandshake(client, {
      port: 8333,
      name: "blueberry",
      version: "0.0.1",
    });
    await peer;

    expect(result.userAgent).toBe("/Satoshi:26.0.0/");
    expect(result.services).toBe(1033n);
    expect(result.startHeight).toBe(850_000);
    expect(result.version).toBe(70_016);
    expect(isSanePeerVersion(result)).toBe(true);
  });

  test("isSanePeerVersion rejects empty agent, zero services, or height", () => {
    const ok = {
      version: 70_016,
      userAgent: "/x/",
      services: 1n,
      startHeight: 1,
    };
    expect(isSanePeerVersion(ok)).toBe(true);
    expect(isSanePeerVersion({ ...ok, userAgent: "" })).toBe(false);
    expect(isSanePeerVersion({ ...ok, services: 0n })).toBe(false);
    expect(isSanePeerVersion({ ...ok, startHeight: 0 })).toBe(false);
  });
});
