export type Peer = {
  host: string;
  port: number;
  services: bigint;
  alive: boolean;
  usedForBlocks: boolean;
  lastProbedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PeerWrite = Omit<Peer, "createdAt" | "updatedAt"> &
  Partial<Pick<Peer, "createdAt" | "updatedAt">>;

export interface PeersRepository {
  upsert(peer: PeerWrite): void;
  list(): Peer[];
  count(): number;
  listAlive(): Peer[];
  /**
   * Alive peers advertising `serviceBits`. Prefer this over listAlive()+filter
   * so callers don't pull the entire alive table into JS.
   */
  listAliveWithServices(
    serviceBits: bigint,
    limit: number,
    options?: { unusedForBlocks?: boolean },
  ): Peer[];
  /**
   * Peers advertising `serviceBits` (any alive state), preferred alive first.
   * Used when the alive pool is exhausted and callers need DB fallbacks.
   */
  listWithServices(serviceBits: bigint, limit: number): Peer[];
  /** Next probe candidates: never-probed first, then oldest lastProbedAt. */
  listProbeQueue(limit: number): Peer[];
  markProbed(host: string, port: number, at: number): void;
  markAlive(host: string, port: number, alive: boolean): void;
  markUsedForBlocks(host: string, port: number): void;
}

/** Persisted header identity (display hash is derived from hashInternalHex). */
export type HeaderRecord = {
  height: number;
  hashInternalHex: string;
  header: Uint8Array;
};

/** Persisted header including write-time cumulative work (trusted on read). */
export type StoredHeader = HeaderRecord & {
  cumulativeWork: bigint;
};

export type HeaderWrite = HeaderRecord & {
  /** If omitted, repository derives work from header bytes + previous tip. */
  cumulativeWork?: bigint;
};

export interface HeadersRepository {
  ensureCheckpoint(checkpoint: HeaderRecord): void;
  tip(): StoredHeader | null;
  count(): number;
  minHeight(): number | null;
  get(height: number): StoredHeader | null;
  heightForHashInternal(hashInternalHex: string): number | null;
  loadRange(fromHeight: number, toHeight: number): StoredHeader[];
  loadAll(): StoredHeader[];
  loadFrom(height: number): StoredHeader[];
  append(headers: HeaderWrite[]): void;
  replaceAfter(commonAncestorHeight: number, headers: HeaderWrite[]): void;
}

export type FilterHeaderRecord = {
  height: number;
  header: Uint8Array;
};

export type FilterRecord = {
  height: number;
  blockHashInternalHex: string;
  filter: Uint8Array;
};

export interface FilterHeadersRepository {
  tip(): FilterHeaderRecord | null;
  get(height: number): FilterHeaderRecord | null;
  minHeight(): number | null;
  loadRange(fromHeight: number, toHeight: number): FilterHeaderRecord[];
  append(rows: FilterHeaderRecord[]): void;
  deleteFrom(height: number): void;
}

export interface FiltersRepository {
  count(): number;
  countInRange(from: number, to: number): number;
  /** Lowest stored filter height, or null if empty. */
  minHeight(): number | null;
  /** Highest stored filter height, or null if empty. */
  maxHeight(): number | null;
  has(height: number): boolean;
  get(height: number): FilterRecord | null;
  /** Lowest height in [from, to] whose filter hash disagrees with the header. */
  firstHashMismatch(from: number, to: number): number | null;
  missingRanges(
    from: number,
    to: number,
    maxSpan: number,
  ): Array<{ from: number; to: number }>;
  /**
   * True when every height in [from, to] has a filter.
   * Uses min/max/count only (no fat-table scan) — safe for hot paths.
   */
  completeInRange(from: number, to: number): boolean;
  append(rows: FilterRecord[]): void;
  listNeedingMatch(limit: number): FilterRecord[];
  /** Filters present minus heights still in `filters_unscanned`. */
  countScanned(): number;
  markScanned(heights: number[]): void;
  /** Re-queue heights for matching (INSERT OR IGNORE into filters_unscanned). */
  markUnscanned(heights: number[]): void;
  /** Re-queue every stored filter with height >= fromHeight. */
  markUnscannedFrom(fromHeight: number): void;
  deleteFrom(height: number): void;
}

export interface KeyValueRepository {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type UtxoNameRow = {
  outpoint: string;
  name: string;
};

export interface UtxoNamesRepository {
  get(outpoint: string): string | null;
  upsert(outpoint: string, name: string): void;
  delete(outpoint: string): void;
  list(): UtxoNameRow[];
}

export type MatchedBlock = {
  height: number;
  blockHashInternalHex: string;
};

export type DownloadedBlock = {
  height: number;
  blockHashInternalHex: string;
  block: Uint8Array;
};

export interface MatchedBlocksRepository {
  /** Insert if missing; returns true when a new row was written. */
  insert(block: MatchedBlock): boolean;
  count(): number;
  /** Matched heights with no row in `blocks`, lowest height first. */
  listNeedingDownload(limit: number): MatchedBlock[];
}

export interface BlocksRepository {
  count(): number;
  has(height: number): boolean;
  get(height: number): DownloadedBlock | null;
  /** Insert if missing; returns true when a new row was written. */
  insert(block: DownloadedBlock): boolean;
  /** Downloaded blocks with no row in `parsed_blocks`, lowest height first. */
  listNeedingParse(limit: number): DownloadedBlock[];
}

export type StoredTx = {
  txid: string;
  height: number;
  txIndex: number;
  blockHashInternalHex: string;
  tx: Uint8Array;
  netDeltaSats: number;
};

export interface ParsedBlocksRepository {
  has(height: number): boolean;
  mark(height: number): void;
  count(): number;
  /** Drop parsed markers for height >= fromHeight (re-parse with expanded watch). */
  clearFrom(fromHeight: number): void;
}

export interface TransactionsRepository {
  upsert(tx: StoredTx): void;
  list(): StoredTx[];
  count(): number;
  /** Lowest stored wallet tx height, or null if empty. */
  minHeight(): number | null;
  setNetDelta(txid: string, netDeltaSats: number): void;
}

export interface Database {
  peers: PeersRepository;
  headers: HeadersRepository;
  filterHeaders: FilterHeadersRepository;
  filters: FiltersRepository;
  matchedBlocks: MatchedBlocksRepository;
  blocks: BlocksRepository;
  parsedBlocks: ParsedBlocksRepository;
  transactions: TransactionsRepository;
  keyValue: KeyValueRepository;
  utxoNames: UtxoNamesRepository;
  close(): void;
}
