import type { NetworkAddress, NetworkAddressV2 } from "bip324";
import type { PeerCandidate } from "./dns-seeds.ts";

export function ipv4BytesToHost(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

export function ipv6BytesToHost(bytes: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((bytes[i]! << 8) | bytes[i + 1]!);
  }
  return groups.map((g) => g.toString(16)).join(":");
}

export function addrV2ToCandidate(
  address: NetworkAddressV2,
): PeerCandidate | undefined {
  if (address.port <= 0 || address.port > 65535) return undefined;
  if (address.networkId === 1 && address.address.length === 4) {
    return {
      host: ipv4BytesToHost(address.address),
      port: address.port,
      services: address.services,
    };
  }
  if (address.networkId === 2 && address.address.length === 16) {
    const host = ipv6BytesToHost(address.address);
    if (host === "0:0:0:0:0:0:0:0") return undefined;
    return { host, port: address.port, services: address.services };
  }
  // onion / unknown network ids
  return undefined;
}

export function legacyAddrToCandidate(
  address: NetworkAddress & { time: number },
): PeerCandidate | undefined {
  if (address.port <= 0 || address.port > 65535) return undefined;
  const ip = address.ip;
  const mapped = ip.subarray(0, 12).every((b, i) => b === (i < 10 ? 0 : 0xff));
  if (mapped) {
    return {
      host: ipv4BytesToHost(ip.subarray(12)),
      port: address.port,
      services: address.services,
    };
  }
  if (ip.every((b) => b === 0)) return undefined;
  return {
    host: ipv6BytesToHost(ip),
    port: address.port,
    services: address.services,
  };
}
