import { describe, expect, spyOn, test } from "bun:test";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { generateMnemonic12 } from "../../src/wallet/generate-mnemonic.ts";

describe("generateMnemonic12", () => {
  test("fills 16 bytes via getRandomValues and yields a valid 12-word mnemonic", () => {
    const spy = spyOn(crypto, "getRandomValues");
    const mnemonic = generateMnemonic12();
    expect(spy).toHaveBeenCalledTimes(1);
    const buf = spy.mock.calls[0]?.[0] as Uint8Array;
    expect(buf).toBeInstanceOf(Uint8Array);
    expect(buf).toHaveLength(16);
    expect(mnemonic.split(" ")).toHaveLength(12);
    expect(validateMnemonic(mnemonic, wordlist)).toBe(true);
    spy.mockRestore();
  });
});
