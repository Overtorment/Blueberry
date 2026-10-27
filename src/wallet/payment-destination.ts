import { isAddressValid } from "./is-address-valid.ts";
import { decodeSilentPaymentAddress } from "./silent-payments.ts";
import { isPaymentCode } from "./bip47.ts";

/** A send destination may require deriving a script from the selected inputs. */
export function isSilentPaymentDestination(value: string): boolean {
  return value.trim().toLowerCase().startsWith("sp1");
}

/** Keep separate from fixed-address validation used by wallet imports/change. */
export function isPaymentDestinationValid(value: string): boolean {
  if (isPaymentCode(value.trim())) return true;
  if (!isSilentPaymentDestination(value)) return isAddressValid(value);
  try {
    decodeSilentPaymentAddress(value.trim());
    return true;
  } catch {
    return false;
  }
}
