import type { Database } from "../db/types.ts";
import { usedWatchIndexes } from "../parse/used-indexes.ts";
import {
  buildSend,
  type BuildSendResult,
  type SendInputUtxo,
} from "../wallet/build-send-tx.ts";
import {
  firstUnusedInternalAddress,
  preferredWifReceiveAddress,
} from "../wallet/receive-address.ts";
import { loadWalletSecret } from "../wallet/secret.ts";
import type { Wallet } from "../wallet/wallet.ts";

export type SendBuildParams = {
  utxos: SendInputUtxo[];
  toAddress: string;
  amountSats: bigint | "max";
  feeRateSatPerVb: number;
};

type Ctx = { db: Database; wallet: Wallet };

let active: Ctx | null = null;

export function setActiveSendContext(db: Database, wallet: Wallet): void {
  active = { db, wallet };
}

function attachNonWitnessUtxos(
  db: Database,
  utxos: SendInputUtxo[],
): SendInputUtxo[] {
  const byTxid = new Map(db.transactions.list().map((t) => [t.txid, t.tx]));
  return utxos.map((u) => {
    if (u.nonWitnessUtxo) return u;
    const prev = byTxid.get(u.txid);
    return prev ? { ...u, nonWitnessUtxo: prev } : u;
  });
}

/**
 * Build a send using the active DB + wallet.
 * BIP84: change from first unused internal.
 * WIF: change = preferred receive address (earliest activity / native default).
 * Address: change = the sole watched address.
 * Mnemonic/WIF → signed tx; zpub/address → unsigned PSBT.
 */
export function buildActiveSendTx(params: SendBuildParams): BuildSendResult {
  if (!active) throw new Error("send context not initialized");
  const { db, wallet } = active;
  wallet.syncFromDb();
  const watch = wallet.snapshot();
  let changeAddress: string;
  if (params.amountSats === "max") {
    changeAddress = params.toAddress;
  } else if (watch.kind === "wif") {
    changeAddress = preferredWifReceiveAddress(
      watch,
      db.transactions.list(),
    ).address;
  } else if (watch.kind === "address") {
    const addr = watch.addresses[0];
    if (!addr) throw new Error("address wallet missing watched address");
    changeAddress = addr.address;
  } else {
    const used = usedWatchIndexes(
      db.transactions.list().map((t) => ({ tx: t.tx })),
      watch,
    );
    const change = firstUnusedInternalAddress(watch, used.internal);
    if (!change) throw new Error("no unused change address in watch window");
    changeAddress = change.address;
  }

  return buildSend({
    secret: loadWalletSecret(db),
    wallet: watch,
    utxos: attachNonWitnessUtxos(db, params.utxos),
    toAddress: params.toAddress,
    amountSats: params.amountSats,
    feeRateSatPerVb: params.feeRateSatPerVb,
    changeAddress,
  });
}

export function pickUtxosByKeys<T extends { key: string }>(
  utxos: T[],
  keys: string[],
): { ok: true; selected: T[] } | { ok: false; error: string } {
  if (keys.length === 0) {
    return { ok: false, error: "no UTXOs selected" };
  }
  const selected = utxos.filter((u) => keys.includes(u.key));
  if (selected.length === 0) {
    return { ok: false, error: "no UTXOs selected" };
  }
  if (selected.length !== keys.length) {
    return { ok: false, error: "some selected UTXOs are no longer available" };
  }
  return { ok: true, selected };
}
