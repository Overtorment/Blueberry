import { isPaymentCode } from "../wallet/bip47.ts";

/** Notifications establish a channel; they never substitute for a payment. */
export function bip47NotificationDetails(
  destination: string,
  selectedSumSats: bigint,
  label = "",
) {
  const toAddress = destination.trim();
  if (!isPaymentCode(toAddress)) {
    throw new Error("Enter a valid BIP47 payment code before creating a notification");
  }
  if (selectedSumSats <= 546n) {
    throw new Error("Select more than 546 sats to cover the notification and its fee");
  }
  return {
    toAddress,
    amountSats: 546n,
    paymentLabel: label.trim() || "BIP47 notification",
    purpose: "bip47-notification" as const,
  };
}
