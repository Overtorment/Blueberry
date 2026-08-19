import type { Database } from "../db/types.ts";
import { outpointKey } from "../parse/extract.ts";

export type SavePaymentLabelParams = {
  txid: string;
  label: string;
  changeVouts: number[];
};

let activeDb: Database | null = null;

export function setActivePaymentLabelContext(db: Database): void {
  activeDb = db;
}

export function savePaymentLabel(params: SavePaymentLabelParams): void {
  if (!activeDb) throw new Error("payment label context not initialized");
  const label = params.label.trim();
  if (!label) throw new Error("payment label is required");
  activeDb.txPaymentLabels.upsert({
    txid: params.txid,
    label,
    changeVouts: params.changeVouts.join(","),
  });
}

export function applyPaymentLabelOnParsedTx(db: Database, txid: string): void {
  const pending = db.txPaymentLabels.get(txid);
  if (!pending) return;
  if (pending.changeVouts === "") return;
  const name = `change from: ${pending.label}`;
  for (const part of pending.changeVouts.split(",")) {
    if (part === "") continue;
    const vout = Number(part);
    const out = outpointKey(txid, vout);
    if (db.utxoNames.get(out) === null) {
      db.utxoNames.upsert(out, name);
    }
  }
}
