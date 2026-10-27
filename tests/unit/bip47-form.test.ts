import { describe, expect, test } from "bun:test";
import { bip47NotificationDetails } from "../../src/tui/bip47-form.ts";

// Alice's public code from the BIP47 reference vectors.
const CODE = "PM8TJTLJbPRGxSbc8EJi42Wrr6QbNSaSSVJ5Y3E4pbCYiTHUskHg13935Ubb7q8tx9GVbh2UuRnBc3WSyJHhUrw8KhprKnn9eDznYGieTzFcwQRya4GA";

describe("explicit BIP47 notification form action", () => {
  test("always creates only the fixed notification amount with a distinct purpose", () => {
    expect(bip47NotificationDetails(` ${CODE} `, 100_000n)).toEqual({
      toAddress: CODE, amountSats: 546n, paymentLabel: "BIP47 notification", purpose: "bip47-notification",
    });
  });

  test("keeps an optional user label while preserving notification purpose", () => {
    expect(bip47NotificationDetails(CODE, 100_000n, "  Alice channel  ").paymentLabel).toBe("Alice channel");
    expect(bip47NotificationDetails(CODE, 100_000n, "   ").paymentLabel).toBe("BIP47 notification");
  });

  test("refuses ordinary destinations and malformed payment codes", () => {
    for (const address of ["", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "PMbad", CODE.slice(0, -1) + "1"])
      expect(() => bip47NotificationDetails(address, 100_000n)).toThrow("valid BIP47");
  });

  test("requires value above the notification amount to leave room for fees", () => {
    for (const amount of [-1n, 0n, 545n, 546n])
      expect(() => bip47NotificationDetails(CODE, amount)).toThrow("more than 546");
  });
});
