export type WatchUtxo = {
  value: bigint;
  scriptPubKey: Uint8Array;
  /** Confirmation height when known (balance / TUI). */
  height?: number;
};

export type ExtractedWatchTx = {
  txid: string;
  txIndex: number;
  tx: Uint8Array;
};

export type BalanceSummary = {
  sats: bigint;
  utxoCount: number;
};
