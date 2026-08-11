import { hex } from "@scure/base";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
  bip32Path,
  p2pkh,
  p2sh,
  p2tr,
  p2wpkh,
  selectUTXO,
  Transaction,
} from "@scure/btc-signer";
import { scriptHex } from "../parse/extract.ts";
import {
  BIP84_ZPUB_VERSIONS,
  decodeWifPrivateKey,
  parseWalletSecret,
} from "./secret.ts";
import type { AddressScriptType, WatchAddress, WatchWallet } from "./types.ts";

export type SendInputUtxo = {
  txid: string;
  vout: number;
  valueSats: bigint;
  scriptPubKey: Uint8Array;
  /** Required for legacy p2pkh inputs (full previous transaction). */
  nonWitnessUtxo?: Uint8Array;
};

export type BuildSendTxParams = {
  secret: string;
  wallet: WatchWallet;
  utxos: SendInputUtxo[];
  toAddress: string;
  amountSats: bigint | "max";
  /** sats per vbyte (may be fractional). With change: fee = ceil(rate × vsize). */
  feeRateSatPerVb: number;
  changeAddress: string;
};

export type BuildSendTxResult = {
  kind: "signed";
  txHex: string;
  feeSats: bigint;
  vsize: number;
  changeSats: bigint;
};

export type BuildSendPsbtResult = {
  kind: "psbt";
  psbtHex: string;
  feeSats: bigint;
  vsize: number;
  changeSats: bigint;
};

export type BuildSendResult = BuildSendTxResult | BuildSendPsbtResult;

function addressForScript(
  wallet: WatchWallet,
  scriptPubKey: Uint8Array,
): WatchAddress {
  const key = scriptHex(scriptPubKey);
  const addr = wallet.addresses.find((a) => scriptHex(a.scriptPubKey) === key);
  if (!addr) throw new Error("UTXO is not a watched address");
  return addr;
}

function scriptTypeOf(addr: WatchAddress): AddressScriptType {
  return addr.scriptType ?? "p2wpkh";
}

function paymentForPubkey(
  scriptType: AddressScriptType,
  publicKey: Uint8Array,
) {
  switch (scriptType) {
    case "p2pkh":
      return p2pkh(publicKey);
    case "p2sh-p2wpkh":
      return p2sh(p2wpkh(publicKey));
    case "p2wpkh":
      return p2wpkh(publicKey);
    case "p2tr":
      return p2tr(publicKey.slice(1));
  }
}

type AccountKey =
  | {
      kind: "mnemonic";
      key: HDKey;
      masterFingerprint: number;
    }
  | {
      kind: "zpub";
      key: HDKey;
      masterFingerprint: number;
    }
  | {
      kind: "wif";
      privateKey: Uint8Array;
      publicKey: Uint8Array;
    }
  | { kind: "address" };

function accountKey(secret: string): AccountKey {
  const parsed = parseWalletSecret(secret);
  if (parsed.kind === "wif") {
    const privateKey = decodeWifPrivateKey(parsed.value);
    return {
      kind: "wif",
      privateKey,
      publicKey: secp256k1.getPublicKey(privateKey, true),
    };
  }
  if (parsed.kind === "mnemonic") {
    const root = HDKey.fromMasterSeed(mnemonicToSeedSync(parsed.value));
    return {
      kind: "mnemonic",
      key: root,
      masterFingerprint: root.fingerprint,
    };
  }
  if (parsed.kind === "address") {
    return { kind: "address" };
  }
  const account = HDKey.fromExtendedKey(parsed.value, BIP84_ZPUB_VERSIONS);
  return {
    kind: "zpub",
    key: account,
    masterFingerprint: 0,
  };
}

function publicKeyAtAddress(
  account: Extract<AccountKey, { kind: "mnemonic" | "zpub" }>,
  addr: WatchAddress,
): Uint8Array {
  if (account.kind === "mnemonic") {
    const child = account.key.derive(addr.path);
    if (!child.publicKey) throw new Error(`missing public key at ${addr.path}`);
    return child.publicKey;
  }
  const child = account.key.derive(`m/${addr.change ? 1 : 0}/${addr.index}`);
  if (!child.publicKey) throw new Error(`missing public key at ${addr.path}`);
  return child.publicKey;
}

function privateKeyAtPath(root: HDKey, path: string): Uint8Array {
  const child = root.derive(path);
  if (!child.privateKey) throw new Error(`missing private key at ${path}`);
  return child.privateKey;
}

function changeSatsFromTx(tx: Transaction, changeAddress: string): bigint {
  let changeSats = 0n;
  for (let i = 0; i < tx.outputsLength; i++) {
    const out = tx.getOutput(i);
    if (tx.getOutputAddress(i) === changeAddress && out.amount !== undefined) {
      changeSats = out.amount;
    }
  }
  return changeSats;
}

/**
 * scure only takes integer sat/vB. Select with ceil(rate), then move excess
 * into change so fee becomes ceil(rate × vsize).
 */
function applyFractionalFee(
  tx: Transaction,
  changeAddress: string,
  selectedFee: bigint,
  rateSatPerVb: number,
  vsize: number,
): bigint {
  const targetFee = BigInt(Math.ceil(rateSatPerVb * vsize));
  const excess = selectedFee - targetFee;
  if (excess <= 0n) return selectedFee;

  for (let i = 0; i < tx.outputsLength; i++) {
    if (tx.getOutputAddress(i) !== changeAddress) continue;
    const out = tx.getOutput(i);
    if (out.amount === undefined) continue;
    tx.updateOutput(i, { amount: out.amount + excess });
    return targetFee;
  }
  // No change output: keep the higher integer-rate fee.
  return selectedFee;
}

function selectSendTx(
  inputs: Parameters<typeof selectUTXO>[0],
  params: BuildSendTxParams,
): { tx: Transaction; feeSats: bigint; vsize: number } {
  const amount = params.amountSats;
  const sendMax = amount === "max";
  const feePerByte = BigInt(Math.ceil(params.feeRateSatPerVb));
  let selected;
  try {
    selected = sendMax
      ? selectUTXO(inputs, [], "all", {
          changeAddress: params.toAddress,
          feePerByte,
          createTx: true,
        })
      : selectUTXO(
          inputs,
          [{ address: params.toAddress, amount }],
          "all",
          {
            changeAddress: params.changeAddress,
            feePerByte,
            createTx: true,
          },
        );
  } catch {
    throw new Error("insufficient funds for amount and fee");
  }
  if (!selected?.tx || selected.fee === undefined) {
    throw new Error("insufficient funds for amount and fee");
  }
  if (sendMax) {
    if (selected.tx.outputsLength !== 1) {
      throw new Error("insufficient funds for amount and fee");
    }
    if (selected.tx.inputsLength !== params.utxos.length) {
      throw new Error("some selected UTXOs are uneconomical at this fee rate");
    }
  }
  const vsize = Math.ceil(selected.weight / 4);
  const feeAdjustAddress = sendMax ? params.toAddress : params.changeAddress;
  const feeSats = applyFractionalFee(
    selected.tx,
    feeAdjustAddress,
    selected.fee,
    params.feeRateSatPerVb,
    vsize,
  );
  if (!sendMax) {
    let inputSum = 0n;
    for (const u of params.utxos) inputSum += u.valueSats;
    if (inputSum < amount + feeSats) {
      throw new Error("insufficient funds for amount and fee");
    }
  }
  return { tx: selected.tx, feeSats, vsize };
}

function buildDraftTx(params: BuildSendTxParams): {
  tx: Transaction;
  signPaths: string[];
  account: AccountKey;
  feeSats: bigint;
  vsize: number;
} {
  if (params.utxos.length === 0) throw new Error("no UTXOs selected");
  const amount = params.amountSats;
  const sendMax = amount === "max";
  if (!sendMax && amount <= 0n) throw new Error("amount must be positive");
  if (!(params.feeRateSatPerVb > 0)) throw new Error("fee rate must be positive");

  const account = accountKey(params.secret);
  const signPaths: string[] = [];

  const inputs = params.utxos.map((u) => {
    const addr = addressForScript(params.wallet, u.scriptPubKey);
    const scriptType = scriptTypeOf(addr);
    signPaths.push(addr.path);

    if (account.kind === "wif") {
      const spend = paymentForPubkey(scriptType, account.publicKey);
      if (scriptType === "p2pkh" && !u.nonWitnessUtxo) {
        throw new Error(
          "legacy p2pkh input requires nonWitnessUtxo (previous transaction)",
        );
      }
      return {
        ...spend,
        txid: hex.decode(u.txid),
        index: u.vout,
        witnessUtxo: {
          script: u.scriptPubKey,
          amount: u.valueSats,
        },
        ...(u.nonWitnessUtxo
          ? { nonWitnessUtxo: u.nonWitnessUtxo }
          : {}),
      };
    }

    if (account.kind === "address") {
      if (scriptType === "p2sh-p2wpkh") {
        throw new Error(
          "nested P2SH watch-only sends are unsupported because the redeem script is unknown",
        );
      }
      if (scriptType === "p2pkh" && !u.nonWitnessUtxo) {
        throw new Error(
          "legacy p2pkh input requires nonWitnessUtxo (previous transaction)",
        );
      }
      return {
        txid: hex.decode(u.txid),
        index: u.vout,
        witnessUtxo: {
          script: u.scriptPubKey,
          amount: u.valueSats,
        },
        ...(u.nonWitnessUtxo
          ? { nonWitnessUtxo: u.nonWitnessUtxo }
          : {}),
      };
    }

    // BIP84 HD: always p2wpkh
    const pubkey = publicKeyAtAddress(account, addr);
    const spend = p2wpkh(pubkey);
    const pathNums = bip32Path(
      addr.path.startsWith("m/") ? addr.path : `m/${addr.path}`,
    );
    return {
      ...spend,
      txid: hex.decode(u.txid),
      index: u.vout,
      witnessUtxo: {
        script: u.scriptPubKey,
        amount: u.valueSats,
      },
      bip32Derivation: [
        [
          pubkey,
          { fingerprint: account.masterFingerprint, path: pathNums },
        ] as [Uint8Array, { fingerprint: number; path: number[] }],
      ],
    };
  });

  // An address exposes only taproot's tweaked output key, not its internal key.
  // This temporary key is for scure weight estimation and is stripped before toPSBT.
  const taprootAddressInput =
    account.kind === "address" &&
    params.utxos.some(
      (u) =>
        scriptTypeOf(addressForScript(params.wallet, u.scriptPubKey)) === "p2tr",
    );
  const selectionInputs = taprootAddressInput
    ? inputs.map((input, index) => {
        const script = params.utxos[index]!.scriptPubKey;
        return scriptTypeOf(addressForScript(params.wallet, script)) === "p2tr"
          ? { ...input, tapInternalKey: script.slice(2) }
          : input;
      })
    : inputs;
  const selected = selectSendTx(selectionInputs, params);
  let tx = selected.tx;
  if (taprootAddressInput) {
    tx = new Transaction();
    for (let i = 0; i < selected.tx.inputsLength; i++) {
      const { tapInternalKey: _estimationOnly, ...input } =
        selected.tx.getInput(i);
      tx.addInput(input);
    }
    for (let i = 0; i < selected.tx.outputsLength; i++) {
      tx.addOutput(selected.tx.getOutput(i));
    }
  }
  const { feeSats, vsize } = selected;
  return { tx, signPaths, account, feeSats, vsize };
}

/**
 * Build and sign a mainnet send. Requires a mnemonic or WIF secret.
 */
export function buildSignedSendTx(params: BuildSendTxParams): BuildSendTxResult {
  const { tx, signPaths, account } = buildDraftTx(params);
  if (account.kind === "zpub" || account.kind === "address") {
    throw new Error("signing requires a mnemonic or WIF wallet secret");
  }
  if (account.kind === "wif") {
    tx.sign(account.privateKey);
  } else {
    for (const path of new Set(signPaths)) {
      tx.sign(privateKeyAtPath(account.key, path));
    }
  }
  tx.finalize();
  return {
    kind: "signed",
    txHex: tx.hex,
    feeSats: tx.fee,
    vsize: tx.vsize,
    changeSats:
      params.amountSats === "max"
        ? 0n
        : changeSatsFromTx(tx, params.changeAddress),
  };
}

/**
 * Build an unsigned PSBT (no signing). Works with mnemonic, zpub, WIF, or address.
 */
export function buildUnsignedSendPsbt(
  params: BuildSendTxParams,
): BuildSendPsbtResult {
  const { tx, feeSats, vsize } = buildDraftTx(params);
  return {
    kind: "psbt",
    psbtHex: hex.encode(tx.toPSBT(0)),
    feeSats,
    vsize,
    changeSats:
      params.amountSats === "max"
        ? 0n
        : changeSatsFromTx(tx, params.changeAddress),
  };
}

/**
 * Mnemonic/WIF → signed tx hex; zpub/address → unsigned PSBT.
 */
export function buildSend(params: BuildSendTxParams): BuildSendResult {
  const parsed = parseWalletSecret(params.secret);
  if (parsed.kind === "mnemonic" || parsed.kind === "wif") {
    return buildSignedSendTx(params);
  }
  if (parsed.kind === "address" && params.amountSats !== "max") {
    const watched = params.wallet.addresses[0];
    if (!watched) throw new Error("address wallet missing watched address");
    return buildUnsignedSendPsbt({
      ...params,
      changeAddress: watched.address,
    });
  }
  return buildUnsignedSendPsbt(params);
}
