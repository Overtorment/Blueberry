import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";

/** 128 bits → 12 BIP39 English words. Uses `crypto.getRandomValues` only. */
export function generateMnemonic12(): string {
  const entropy = new Uint8Array(16);
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy, wordlist);
}
