import { describe, expect, test } from "bun:test";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";
import {
  firstUnusedExternalAddress,
  firstUnusedInternalAddress,
} from "../../src/wallet/receive-address.ts";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("firstUnusedExternalAddress", () => {
  test("returns external index 0 when nothing used", () => {
    const wallet = deriveWatchWallet(ABANDON, { external: 3, internal: 1 });
    const addr = firstUnusedExternalAddress(wallet, []);
    expect(addr?.index).toBe(0);
    expect(addr?.change).toBe(false);
    expect(addr?.address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
  });

  test("skips used indexes; ignores internal", () => {
    const wallet = deriveWatchWallet(ABANDON, { external: 5, internal: 2 });
    const addr = firstUnusedExternalAddress(wallet, [0, 1, 3]);
    expect(addr?.index).toBe(2);
    expect(addr?.change).toBe(false);
  });

  test("null when every external in the watch window is used", () => {
    const wallet = deriveWatchWallet(ABANDON, { external: 2, internal: 1 });
    expect(firstUnusedExternalAddress(wallet, [0, 1])).toBeNull();
  });
});

describe("firstUnusedInternalAddress", () => {
  test("returns change index 0 when nothing used", () => {
    const wallet = deriveWatchWallet(ABANDON, { external: 1, internal: 3 });
    const addr = firstUnusedInternalAddress(wallet, []);
    expect(addr?.index).toBe(0);
    expect(addr?.change).toBe(true);
  });

  test("skips used change indexes", () => {
    const wallet = deriveWatchWallet(ABANDON, { external: 1, internal: 4 });
    expect(firstUnusedInternalAddress(wallet, [0, 2])?.index).toBe(1);
  });

  test("null when every internal in the watch window is used", () => {
    const wallet = deriveWatchWallet(ABANDON, { external: 1, internal: 2 });
    expect(firstUnusedInternalAddress(wallet, [0, 1])).toBeNull();
  });
});

