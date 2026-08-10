/**
 * Bitcoin P2P transport v1 (cleartext): magic + command + length + checksum.
 * Payload codecs come from bip324 (`encodeVersion` / `decodeVersion`).
 */
import {
  Networks,
  decodeVersion,
  encodeVersion,
  equalBytes,
  sha256d,
  type ByteDuplex,
  type VersionPayload,
} from "bip324";

const HEADER_LEN = 24;
const MAX_PAYLOAD = 1_000_000;

export class NotV1PeerError extends Error {
  constructor(message = "peer is not Bitcoin P2P v1") {
    super(message);
    this.name = "NotV1PeerError";
  }
}

export type V1Message = {
  command: string;
  payload: Uint8Array;
};

export type V1VersionHandshakeOptions = {
  port: number;
  name: string;
  version: string;
  startHeight?: number;
  services?: bigint;
  magic?: Uint8Array;
};

export type V1VersionHandshakeResult = {
  version: number;
  userAgent: string;
  services: bigint;
  startHeight: number;
};

function commandBytes(command: string): Uint8Array {
  if (command.length === 0 || command.length > 12) {
    throw new Error(`command length must be in [1, 12], got ${command.length}`);
  }
  const out = new Uint8Array(12);
  for (let i = 0; i < command.length; i++) {
    const code = command.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) {
      throw new Error("command must contain printable ASCII only");
    }
    out[i] = code;
  }
  return out;
}

function parseCommand(bytes: Uint8Array): string {
  const nul = bytes.indexOf(0);
  const end = nul === -1 ? bytes.length : nul;
  if (end === 0) throw new Error("empty command");
  for (let i = 0; i < end; i++) {
    if (bytes[i]! < 0x20 || bytes[i]! > 0x7e) {
      throw new Error("command must contain printable ASCII only");
    }
  }
  for (let i = end; i < bytes.length; i++) {
    if (bytes[i] !== 0) throw new Error("nonzero byte after command padding");
  }
  let command = "";
  for (let i = 0; i < end; i++) command += String.fromCharCode(bytes[i]!);
  return command;
}

export function encodeV1Frame(
  magic: Uint8Array,
  command: string,
  payload: Uint8Array,
): Uint8Array {
  if (magic.length !== 4) throw new Error("magic must be 4 bytes");
  if (payload.length > MAX_PAYLOAD) {
    throw new Error(`payload too large: ${payload.length}`);
  }
  const out = new Uint8Array(HEADER_LEN + payload.length);
  out.set(magic, 0);
  out.set(commandBytes(command), 4);
  new DataView(out.buffer, out.byteOffset + 16, 4).setUint32(
    0,
    payload.length,
    true,
  );
  out.set(sha256d(payload).subarray(0, 4), 20);
  out.set(payload, HEADER_LEN);
  return out;
}

export function decodeV1Frame(
  frame: Uint8Array,
  magic: Uint8Array,
): V1Message {
  if (frame.length < HEADER_LEN) throw new Error("truncated v1 frame");
  const gotMagic = frame.subarray(0, 4);
  if (!equalBytes(gotMagic, magic)) {
    throw new NotV1PeerError(
      `peer magic mismatch: got ${[...gotMagic].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    );
  }
  const command = parseCommand(frame.subarray(4, 16));
  const length = new DataView(
    frame.buffer,
    frame.byteOffset + 16,
    4,
  ).getUint32(0, true);
  if (length > MAX_PAYLOAD) throw new Error(`payload too large: ${length}`);
  if (frame.length !== HEADER_LEN + length) {
    throw new Error(
      `frame length mismatch: header says ${length}, got ${frame.length - HEADER_LEN}`,
    );
  }
  const checksum = frame.subarray(20, 24);
  const payload = frame.subarray(HEADER_LEN);
  const expected = sha256d(payload).subarray(0, 4);
  if (!equalBytes(checksum, expected)) {
    throw new Error("v1 message checksum mismatch");
  }
  return { command, payload };
}

async function readExactly(
  duplex: ByteDuplex,
  n: number,
): Promise<Uint8Array> {
  const out = new Uint8Array(n);
  let offset = 0;
  while (offset < n) {
    const chunk = await duplex.read(n - offset);
    if (chunk.length === 0) {
      throw new Error(`unexpected EOF: wanted ${n} bytes, got ${offset}`);
    }
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function writeV1Message(
  duplex: ByteDuplex,
  magic: Uint8Array,
  command: string,
  payload: Uint8Array,
): Promise<void> {
  await duplex.write(encodeV1Frame(magic, command, payload));
}

export async function readV1Message(
  duplex: ByteDuplex,
  magic: Uint8Array,
): Promise<V1Message> {
  // Read magic first so BIP-324 (or other) peers fail fast without waiting
  // for a full 24-byte v1 header.
  const gotMagic = await readExactly(duplex, 4);
  if (!equalBytes(gotMagic, magic)) {
    throw new NotV1PeerError(
      `peer magic mismatch: got ${[...gotMagic].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
    );
  }
  const restHeader = await readExactly(duplex, HEADER_LEN - 4);
  const header = new Uint8Array(HEADER_LEN);
  header.set(gotMagic);
  header.set(restHeader, 4);
  const length = new DataView(
    header.buffer,
    header.byteOffset + 16,
    4,
  ).getUint32(0, true);
  if (length > MAX_PAYLOAD) throw new Error(`payload too large: ${length}`);
  const payload =
    length === 0 ? new Uint8Array(0) : await readExactly(duplex, length);
  const full = new Uint8Array(HEADER_LEN + payload.length);
  full.set(header);
  full.set(payload, HEADER_LEN);
  return decodeV1Frame(full, magic);
}

function buildLocalVersion(
  options: V1VersionHandshakeOptions,
): VersionPayload {
  const random = crypto.getRandomValues(new Uint8Array(8));
  const nonce = new DataView(
    random.buffer,
    random.byteOffset,
    8,
  ).getBigUint64(0, true);
  return {
    version: 70_016,
    services: options.services ?? 0n,
    timestamp: BigInt(Math.floor(Date.now() / 1_000)),
    receiver: { services: 0n, ip: new Uint8Array(16), port: options.port },
    sender: { services: 0n, ip: new Uint8Array(16), port: 0 },
    nonce,
    userAgent: `/${options.name}:${options.version}/`,
    startHeight: options.startHeight ?? 0,
    relay: false,
  };
}

/**
 * Initiator v1 version/verack handshake. Throws NotV1PeerError if the peer
 * does not speak cleartext v1 (for example BIP-324-only).
 */
export async function completeV1VersionHandshake(
  duplex: ByteDuplex,
  options: V1VersionHandshakeOptions,
): Promise<V1VersionHandshakeResult> {
  const magic = options.magic ?? Networks.mainnet.magic;
  await writeV1Message(
    duplex,
    magic,
    "version",
    encodeVersion(buildLocalVersion(options)),
  );

  let receivedVersion = false;
  let receivedVerack = false;
  let peer: VersionPayload | undefined;

  while (!receivedVersion || !receivedVerack) {
    const message = await readV1Message(duplex, magic);
    if (message.command === "version") {
      receivedVersion = true;
      peer = decodeVersion(message.payload);
      await writeV1Message(duplex, magic, "verack", new Uint8Array(0));
    } else if (message.command === "verack") {
      receivedVerack = true;
    } else if (message.command === "ping" && message.payload.length === 8) {
      await writeV1Message(duplex, magic, "pong", message.payload);
    }
  }

  if (!peer) throw new Error("missing peer version");
  return {
    version: peer.version,
    userAgent: peer.userAgent,
    services: peer.services,
    startHeight: peer.startHeight,
  };
}

export function isSanePeerVersion(peer: V1VersionHandshakeResult): boolean {
  return (
    peer.userAgent.length > 0 &&
    peer.services !== 0n &&
    peer.startHeight > 0 &&
    peer.version >= 70_000
  );
}
