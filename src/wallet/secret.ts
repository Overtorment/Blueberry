import { HDKey } from "@scure/bip32";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { WIF } from "@scure/btc-signer";

/** SLIP-0132 mainnet BIP84 (zpub/zprv). */
export const BIP84_ZPUB_VERSIONS = {
  private: 0x04b2430c,
  public: 0x04b24746,
} as const;

export const WALLET_SECRET_KEY = "wallet_secret";

/** BIP32 depth of m/84'/0'/0' */
const ACCOUNT_DEPTH = 3;

const wifCodec = WIF();

export type WalletSecretKind = "mnemonic" | "zpub" | "wif";

export type ParsedWalletSecret = {
  kind: WalletSecretKind;
  value: string;
};

type Kv = {
  keyValue: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
};

/** WIF-shaped single base58 token (mainnet or testnet; no whitespace). */
function looksLikeWifCandidate(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (value.length < 51 || value.length > 52) return false;
  return /^[5KL9c]/.test(value);
}

/**
 * Decode mainnet compressed WIF → 32-byte private key.
 * Rejects uncompressed (`5…` / `9…`) and testnet (`c…` / `9…`).
 */
export function decodeWifPrivateKey(wif: string): Uint8Array {
  const value = wif.trim();
  if (!value) throw new Error("invalid WIF");
  if (value.startsWith("c") || value.startsWith("9")) {
    throw new Error("only mainnet compressed WIF is supported (not testnet)");
  }
  if (value.startsWith("5")) {
    throw new Error("uncompressed WIF is not supported; use compressed WIF");
  }
  try {
    return wifCodec.decode(value);
  } catch {
    throw new Error("invalid WIF");
  }
}

export function parseWalletSecret(raw: string): ParsedWalletSecret {
  const value = raw.trim();
  if (!value) throw new Error("wallet secret is empty");

  if (value.startsWith("zpub")) {
    let key: HDKey;
    try {
      key = HDKey.fromExtendedKey(value, BIP84_ZPUB_VERSIONS);
    } catch {
      throw new Error("invalid zpub");
    }
    if (key.depth !== ACCOUNT_DEPTH) {
      throw new Error("zpub must be account-level (m/84'/0'/0')");
    }
    if (!key.publicKey) throw new Error("invalid zpub");
    return { kind: "zpub", value };
  }

  if (
    value.startsWith("xpub") ||
    value.startsWith("ypub") ||
    value.startsWith("vpub") ||
    value.startsWith("tpub")
  ) {
    throw new Error("only mainnet account zpub is supported");
  }

  if (looksLikeWifCandidate(value)) {
    decodeWifPrivateKey(value);
    return { kind: "wif", value };
  }

  if (!validateMnemonic(value, wordlist)) {
    throw new Error("invalid BIP39 mnemonic");
  }
  return { kind: "mnemonic", value };
}

export function hasWalletSecret(db: Kv): boolean {
  const v = db.keyValue.get(WALLET_SECRET_KEY);
  return v !== null && v.trim().length > 0;
}

export type WalletSecretInspection =
  | { status: "missing" }
  | { status: "ok"; value: string }
  | { status: "invalid"; detail: string };

/**
 * Boot-gate view of `wallet_secret`:
 * - missing → onboarding
 * - ok → start app
 * - invalid → error and exit (do not open onboarding; leave the row as-is)
 */
export function inspectWalletSecret(db: Kv): WalletSecretInspection {
  const raw = db.keyValue.get(WALLET_SECRET_KEY);
  if (raw === null || !raw.trim()) return { status: "missing" };
  try {
    const parsed = parseWalletSecret(raw);
    return { status: "ok", value: parsed.value };
  } catch (err) {
    return {
      status: "invalid",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function loadWalletSecret(db: Kv): string {
  const v = db.keyValue.get(WALLET_SECRET_KEY);
  if (v === null || !v.trim()) throw new Error("wallet_secret missing");
  return v.trim();
}

export function saveWalletSecret(db: Kv, raw: string): ParsedWalletSecret {
  const parsed = parseWalletSecret(raw);
  db.keyValue.set(WALLET_SECRET_KEY, parsed.value);
  return parsed;
}
