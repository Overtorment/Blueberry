import type { SyncFromYearInspection } from "../sync-year.ts";
import type { WalletSecretInspection } from "../wallet/secret.ts";

export type OnboardingGate =
  | { action: "exit-invalid"; detail: string }
  | { action: "onboard"; startAtYearStep: boolean }
  | { action: "encrypt" }
  | { action: "unlock" };

/** Pure boot routing for wallet_secret + sync_from_year. */
export function resolveOnboardingGate(
  wallet: WalletSecretInspection,
  year: SyncFromYearInspection,
): OnboardingGate {
  if (wallet.status === "invalid") {
    return { action: "exit-invalid", detail: wallet.detail };
  }
  if (wallet.status === "missing") {
    return { action: "onboard", startAtYearStep: false };
  }
  if (year.status === "missing") {
    return { action: "onboard", startAtYearStep: true };
  }
  if (wallet.status === "encrypted") {
    return { action: "unlock" };
  }
  return { action: "encrypt" };
}
