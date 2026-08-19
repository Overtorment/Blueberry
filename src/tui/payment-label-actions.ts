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
  });
  const name = `change from: ${label}`;
  for (const vout of params.changeVouts) {
    activeDb.utxoNames.upsert(outpointKey(params.txid, vout), name);
  }
}
