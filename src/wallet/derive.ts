import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2pkh, p2sh, p2tr, p2wpkh } from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1";
import { address as btcAddress } from "bitcoinjs-lib";
import { config } from "../config.ts";
import type {
  AddressScriptType,
  WatchAddress,
  WatchWallet,
} from "./types.ts";
import {
  BIP84_ZPUB_VERSIONS,
  decodeWif,
  parseWalletSecret,
} from "./secret.ts";
import { watchAddressScriptType } from "./is-address-valid.ts";

/** BIP84 account path (mainnet). */
export const BIP84_ACCOUNT_PATH = "m/84'/0'/0'";

export const WATCH_EXTERNAL_KEY = "watch_external";
export const WATCH_INTERNAL_KEY = "watch_internal";

export type WatchGaps = { external: number; internal: number };

/** Stable order for WIF unwrap (legacy → wrapped → native → taproot). */
export const WIF_SCRIPT_TYPES: AddressScriptType[] = [
  "p2pkh",
  "p2sh-p2wpkh",
  "p2wpkh",
  "p2tr",
];

function normalizeGaps(gaps?: number | WatchGaps): WatchGaps {
  if (gaps === undefined) {
    const n = config.initialWatchCount;
    return { external: n, internal: n };
  }
  if (typeof gaps === "number") return { external: gaps, internal: gaps };
  return {
    external: Math.max(0, Math.floor(gaps.external)),
    internal: Math.max(0, Math.floor(gaps.internal)),
  };
}

function deriveWifWatchWallet(wif: string): WatchWallet {
  const { privateKey, compressed } = decodeWif(wif);
  const publicKey = secp256k1.getPublicKey(privateKey, compressed);

  if (!compressed) {
    const pay = p2pkh(publicKey);
    if (!pay.address) {
      throw new Error("failed to encode p2pkh address from WIF");
    }
    const addr: WatchAddress = {
      path: "wif/p2pkh",
      index: 0,
      change: false,
      address: pay.address,
      scriptPubKey: new Uint8Array(pay.script),
      scriptType: "p2pkh",
    };
    return {
      kind: "wif",
      secret: wif,
      addresses: [addr],
      scripts: [addr.scriptPubKey],
    };
  }

  const xOnly = publicKey.slice(1);
  const payments: Record<
    AddressScriptType,
    { address?: string; script: Uint8Array }
  > = {
    p2pkh: p2pkh(publicKey),
    "p2sh-p2wpkh": p2sh(p2wpkh(publicKey)),
    p2wpkh: p2wpkh(publicKey),
    p2tr: p2tr(xOnly),
  };

  const addresses: WatchAddress[] = WIF_SCRIPT_TYPES.map((scriptType, index) => {
    const pay = payments[scriptType];
    if (!pay.address) {
      throw new Error(`failed to encode ${scriptType} address from WIF`);
    }
    return {
      path: `wif/${scriptType}`,
      index,
      change: false,
      address: pay.address,
      scriptPubKey: new Uint8Array(pay.script),
      scriptType,
    };
  });

  return {
    kind: "wif",
    secret: wif,
    addresses,
    scripts: addresses.map((a) => a.scriptPubKey),
  };
}

function outputScriptFromAddress(address: string): Uint8Array {
  const lower = address.toLowerCase();
  if (lower.startsWith("bc1")) {
    const decoded = btcAddress.fromBech32(address);
    if (decoded.version === 1 && decoded.data.length === 32) {
      const script = new Uint8Array(34);
      script[0] = 0x51;
      script[1] = 0x20;
      script.set(decoded.data, 2);
      return script;
    }
  }
  return new Uint8Array(btcAddress.toOutputScript(address));
}

function deriveAddressWatchWallet(address: string): WatchWallet {
  const scriptPubKey = outputScriptFromAddress(address);
  const scriptType = watchAddressScriptType(address);
  const watchAddr: WatchAddress = {
    path: "address/0",
    index: 0,
    change: false,
    address,
    scriptPubKey,
    scriptType,
  };
  return {
    kind: "address",
    secret: address,
    addresses: [watchAddr],
    scripts: [scriptPubKey],
  };
}

function deriveBip84WatchWallet(
  secret: string,
  kind: "mnemonic" | "zpub",
  gaps: WatchGaps,
): WatchWallet {
  const { external, internal } = gaps;

  let account: HDKey;
  if (kind === "mnemonic") {
    const seed = mnemonicToSeedSync(secret);
    const root = HDKey.fromMasterSeed(seed);
    account = root.derive(BIP84_ACCOUNT_PATH);
  } else {
    account = HDKey.fromExtendedKey(secret, BIP84_ZPUB_VERSIONS);
  }

  const addresses: WatchAddress[] = [];
  const chains: Array<{ change: boolean; count: number }> = [
    { change: false, count: external },
    { change: true, count: internal },
  ];
  for (const { change, count } of chains) {
    const chain = change ? 1 : 0;
    for (let index = 0; index < count; index++) {
      const path = `${BIP84_ACCOUNT_PATH}/${chain}/${index}`;
      const child = account.derive(`m/${chain}/${index}`);
      if (!child.publicKey) throw new Error(`missing public key at ${path}`);
      const { address, script } = p2wpkh(child.publicKey);
      if (!address) throw new Error(`failed to encode address at ${path}`);
      addresses.push({
        path,
        index,
        change,
        address,
        scriptPubKey: new Uint8Array(script),
        scriptType: "p2wpkh",
      });
    }
  }
  return {
    kind: "bip84",
    secret,
    addresses,
    scripts: addresses.map((a) => a.scriptPubKey),
  };
}

export function deriveWatchWallet(
  secret: string,
  gaps?: number | WatchGaps,
): WatchWallet {
  const parsed = parseWalletSecret(secret);
  if (parsed.kind === "wif") {
    return deriveWifWatchWallet(parsed.value);
  }
  if (parsed.kind === "address") {
    return deriveAddressWatchWallet(parsed.value);
  }
  return deriveBip84WatchWallet(
    parsed.value,
    parsed.kind,
    normalizeGaps(gaps),
  );
}
