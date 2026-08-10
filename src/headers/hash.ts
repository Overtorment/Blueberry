import { bytesToHex, hexToBytes } from "bitcoin-headers";

/** Explorer/RPC display hash: byte-reverse of wire/internal hex. */
export function internalHexToDisplayHex(internalHex: string): string {
  return bytesToHex(hexToBytes(internalHex).slice().reverse());
}
