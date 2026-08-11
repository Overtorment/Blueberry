/** Script / address type for a watched output. */
export type AddressScriptType =
  | "p2pkh"
  | "p2sh-p2wpkh"
  | "p2wpkh"
  | "p2tr";

export type WatchWalletKind = "bip84" | "wif" | "address";

export type WatchAddress = {
  path: string;
  index: number;
  /** false = external (receive), true = internal (change). */
  change: boolean;
  address: string;
  scriptPubKey: Uint8Array;
  /**
   * Always set for WIF watches. BIP84 HD watches are `p2wpkh` (may be omitted
   * for backward compatibility; treat missing as p2wpkh).
   */
  scriptType?: AddressScriptType;
};

export type WatchWallet = {
  kind: WatchWalletKind;
  secret: string;
  addresses: WatchAddress[];
  scripts: Uint8Array[];
};
