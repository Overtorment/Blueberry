import { constants, Database as BunDatabase } from "bun:sqlite";
import {
  decodeBlockHeader,
  decodeCompactTarget,
  equalBytes,
  headerWork,
  MAINNET_POW_LIMIT,
} from "bitcoin-headers";
import { ensureSchema } from "./schema.ts";
import type {
  BlocksRepository,
  Database,
  FilterHeaderRecord,
  FilterHeadersRepository,
  FilterRecord,
  FiltersRepository,
  HeaderWrite,
  HeadersRepository,
  KeyValueRepository,
  MatchedBlocksRepository,
  ParsedBlocksRepository,
  Peer,
  PeerWrite,
  PeersRepository,
  StoredHeader,
  StoredTx,
  TransactionsRepository,
  UtxoNamesRepository,
} from "./types.ts";

type PeerRow = {
  host: string;
  port: number;
  services: string;
  alive: number;
  used_for_blocks: number;
  last_probed_at: number | null;
  created_at: number;
  updated_at: number;
};

type HeaderRow = {
  height: number;
  hash_internal_hex: string;
  header: Uint8Array;
  cumulative_work: string;
};

type FilterHeaderRow = {
  height: number;
  header: Uint8Array;
};

type FilterRow = {
  height: number;
  block_hash_internal_hex: string;
  filter: Uint8Array;
};

function rowToFilterHeader(row: FilterHeaderRow): FilterHeaderRecord {
  return {
    height: row.height,
    header: row.header,
  };
}

function rowToFilter(row: FilterRow): FilterRecord {
  return {
    height: row.height,
    blockHashInternalHex: row.block_hash_internal_hex,
    filter: row.filter,
  };
}

function rowToHeader(row: HeaderRow): StoredHeader {
  return {
    height: row.height,
    hashInternalHex: row.hash_internal_hex,
    header: row.header,
    cumulativeWork: BigInt(row.cumulative_work),
  };
}

function rowToPeer(row: PeerRow): Peer {
  return {
    host: row.host,
    port: row.port,
    services: BigInt(row.services),
    alive: row.alive === 1,
    usedForBlocks: row.used_for_blocks === 1,
    lastProbedAt: row.last_probed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function headerWorkFromBytes(header: Uint8Array): bigint {
  try {
    const decoded = decodeBlockHeader(header);
    const target = decodeCompactTarget(decoded.bits, MAINNET_POW_LIMIT);
    return headerWork(target);
  } catch {
    // Placeholder headers in unit tests.
    return 1n;
  }
}

export function createSqliteDatabase(path: string): Database {
  const raw = new BunDatabase(path);
  raw.exec("PRAGMA journal_mode = WAL;");
  // 18GB+ filter DBs thrash with the default 2MB page cache.
  raw.exec("PRAGMA cache_size = -262144;"); // 256 MiB
  raw.exec("PRAGMA mmap_size = 1073741824;"); // 1 GiB
  // WAL + NORMAL is durable enough and avoids FULL fsync on every commit.
  raw.exec("PRAGMA synchronous = NORMAL;");
  raw.exec("PRAGMA wal_autocheckpoint = 10000;");
  // Leave -wal/-shm on disk across process death / process.exit without close().
  // Quit path skips db.close() so we never block on a full WAL checkpoint.
  try {
    raw.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 1);
  } catch {
    // older bun builds — ignore
  }
  ensureSchema(raw);
  // Shrink a bloated WAL without blocking writers (no-op if nothing to do).
  try {
    raw.exec("PRAGMA wal_checkpoint(PASSIVE);");
  } catch {
    // ignore
  }

  const peers: PeersRepository = {
    upsert(peer: PeerWrite) {
      const now = Date.now();
      const createdAt = peer.createdAt ?? now;
      const updatedAt = peer.updatedAt ?? now;
      raw
        .query(
          `INSERT INTO peers (
            host, port, services, alive, used_for_blocks,
            last_probed_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(host, port) DO UPDATE SET
            services = excluded.services,
            updated_at = excluded.updated_at`,
        )
        .run(
          peer.host,
          peer.port,
          peer.services.toString(),
          peer.alive ? 1 : 0,
          peer.usedForBlocks ? 1 : 0,
          peer.lastProbedAt,
          createdAt,
          updatedAt,
        );
    },

    list() {
      const rows = raw
        .query("SELECT * FROM peers ORDER BY host, port")
        .all() as PeerRow[];
      return rows.map(rowToPeer);
    },

    count() {
      const row = raw.query("SELECT COUNT(*) AS n FROM peers").get() as {
        n: number;
      };
      return row.n;
    },

    listAlive() {
      const rows = raw
        .query(
          "SELECT * FROM peers WHERE alive = 1 ORDER BY host, port",
        )
        .all() as PeerRow[];
      return rows.map(rowToPeer);
    },

    listAliveWithServices(serviceBits, limit, options) {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      const mask = serviceBits.toString();
      const unused = options?.unusedForBlocks === true;
      const rows = (
        unused
          ? raw.query(
              `SELECT * FROM peers
               WHERE alive = 1
                 AND used_for_blocks = 0
                 AND (CAST(services AS INTEGER) & CAST(? AS INTEGER)) != 0
               ORDER BY host, port
               LIMIT ?`,
            )
          : raw.query(
              `SELECT * FROM peers
               WHERE alive = 1
                 AND (CAST(services AS INTEGER) & CAST(? AS INTEGER)) != 0
               ORDER BY host, port
               LIMIT ?`,
            )
      ).all(mask, n) as PeerRow[];
      return rows.map(rowToPeer);
    },

    listWithServices(serviceBits, limit) {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      const mask = serviceBits.toString();
      const rows = raw
        .query(
          `SELECT * FROM peers
           WHERE (CAST(services AS INTEGER) & CAST(? AS INTEGER)) != 0
           ORDER BY alive DESC,
             CASE WHEN last_probed_at IS NULL THEN 0 ELSE 1 END,
             last_probed_at ASC,
             host, port
           LIMIT ?`,
        )
        .all(mask, n) as PeerRow[];
      return rows.map(rowToPeer);
    },

    listProbeQueue(limit) {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      const rows = raw
        .query(
          `SELECT * FROM peers
           ORDER BY
             CASE WHEN last_probed_at IS NULL THEN 0 ELSE 1 END,
             last_probed_at ASC,
             CASE WHEN instr(host, ':') > 0 THEN 1 ELSE 0 END,
             host, port
           LIMIT ?`,
        )
        .all(n) as PeerRow[];
      return rows.map(rowToPeer);
    },

    markProbed(host, port, at) {
      raw
        .query(
          `UPDATE peers
           SET last_probed_at = ?, updated_at = ?
           WHERE host = ? AND port = ?`,
        )
        .run(at, Date.now(), host, port);
    },

    markAlive(host, port, alive) {
      raw
        .query(
          `UPDATE peers
           SET alive = ?, updated_at = ?
           WHERE host = ? AND port = ?`,
        )
        .run(alive ? 1 : 0, Date.now(), host, port);
    },

    markUsedForBlocks(host, port) {
      raw
        .query(
          `UPDATE peers
           SET used_for_blocks = 1, updated_at = ?
           WHERE host = ? AND port = ?`,
        )
        .run(Date.now(), host, port);
    },
  };

  const insertHeader = raw.query(
    `INSERT INTO headers (
      height, hash_internal_hex, header, cumulative_work
    ) VALUES (?, ?, ?, ?)`,
  );

  function insertWrites(headerRecords: HeaderWrite[], startingWork: bigint) {
    let cumulative = startingWork;
    for (const h of headerRecords) {
      if (h.cumulativeWork !== undefined) {
        cumulative = h.cumulativeWork;
      } else {
        cumulative += headerWorkFromBytes(h.header);
      }
      insertHeader.run(
        h.height,
        h.hashInternalHex,
        h.header,
        cumulative.toString(),
      );
    }
  }

  const headers: HeadersRepository = {
    ensureCheckpoint(checkpoint) {
      const n = this.count();
      if (n === 0) {
        const work = headerWorkFromBytes(checkpoint.header);
        insertHeader.run(
          checkpoint.height,
          checkpoint.hashInternalHex,
          checkpoint.header,
          work.toString(),
        );
        return;
      }
      const row = raw
        .query(
          "SELECT * FROM headers ORDER BY height ASC LIMIT 1",
        )
        .get() as HeaderRow | null;
      if (!row) {
        throw new Error("checkpoint: headers table inconsistent");
      }
      const existing = rowToHeader(row);
      if (
        existing.height !== checkpoint.height ||
        existing.hashInternalHex !== checkpoint.hashInternalHex ||
        !equalBytes(existing.header, checkpoint.header)
      ) {
        throw new Error(
          `checkpoint mismatch: stored height ${existing.height} hashInternalHex ${existing.hashInternalHex}, ` +
            `expected height ${checkpoint.height} hashInternalHex ${checkpoint.hashInternalHex}. ` +
            `Delete blueberry.data/blueberry.sqlite (or clear headers rows) and restart.`,
        );
      }
    },

    tip() {
      const row = raw
        .query("SELECT * FROM headers ORDER BY height DESC LIMIT 1")
        .get() as HeaderRow | null;
      return row ? rowToHeader(row) : null;
    },

    count() {
      const row = raw.query("SELECT COUNT(*) AS n FROM headers").get() as {
        n: number;
      };
      return row.n;
    },

    minHeight() {
      const row = raw
        .query("SELECT MIN(height) AS h FROM headers")
        .get() as { h: number | null };
      return row.h ?? null;
    },

    get(height) {
      const row = raw
        .query("SELECT * FROM headers WHERE height = ?")
        .get(height) as HeaderRow | null;
      return row ? rowToHeader(row) : null;
    },

    heightForHashInternal(hashInternalHex) {
      const row = raw
        .query(
          "SELECT height FROM headers WHERE hash_internal_hex = ? LIMIT 1",
        )
        .get(hashInternalHex) as { height: number } | null;
      return row?.height ?? null;
    },

    loadRange(fromHeight, toHeight) {
      const rows = raw
        .query(
          `SELECT * FROM headers
           WHERE height >= ? AND height <= ?
           ORDER BY height ASC`,
        )
        .all(fromHeight, toHeight) as HeaderRow[];
      return rows.map(rowToHeader);
    },

    loadAll() {
      const rows = raw
        .query("SELECT * FROM headers ORDER BY height ASC")
        .all() as HeaderRow[];
      return rows.map(rowToHeader);
    },

    loadFrom(height) {
      const rows = raw
        .query(
          "SELECT * FROM headers WHERE height >= ? ORDER BY height ASC",
        )
        .all(height) as HeaderRow[];
      return rows.map(rowToHeader);
    },

    append(headerRecords) {
      if (headerRecords.length === 0) return;
      const tip = this.tip();
      // One transaction: 2000 autocommit inserts block the event loop for seconds
      // (quit/keypress starve). A single COMMIT is milliseconds.
      raw.exec("BEGIN");
      try {
        insertWrites(headerRecords, tip?.cumulativeWork ?? 0n);
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },

    replaceAfter(commonAncestorHeight, headerRecords) {
      raw.exec("BEGIN");
      try {
        raw
          .query("DELETE FROM headers WHERE height > ?")
          .run(commonAncestorHeight);
        const ancestor = this.get(commonAncestorHeight);
        insertWrites(headerRecords, ancestor?.cumulativeWork ?? 0n);
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };

  const insertFilterHeader = raw.query(
    `INSERT INTO filter_headers (height, header) VALUES (?, ?)`,
  );

  const filterHeaders: FilterHeadersRepository = {
    tip() {
      const row = raw
        .query("SELECT * FROM filter_headers ORDER BY height DESC LIMIT 1")
        .get() as FilterHeaderRow | null;
      return row ? rowToFilterHeader(row) : null;
    },

    get(height) {
      const row = raw
        .query("SELECT * FROM filter_headers WHERE height = ?")
        .get(height) as FilterHeaderRow | null;
      return row ? rowToFilterHeader(row) : null;
    },

    minHeight() {
      const row = raw
        .query("SELECT MIN(height) AS h FROM filter_headers")
        .get() as { h: number | null };
      return row.h ?? null;
    },

    loadRange(fromHeight, toHeight) {
      const rows = raw
        .query(
          `SELECT * FROM filter_headers
           WHERE height >= ? AND height <= ?
           ORDER BY height ASC`,
        )
        .all(fromHeight, toHeight) as FilterHeaderRow[];
      return rows.map(rowToFilterHeader);
    },

    append(rows) {
      if (rows.length === 0) return;
      raw.exec("BEGIN");
      try {
        for (const row of rows) {
          insertFilterHeader.run(row.height, row.header);
        }
        raw.exec("COMMIT");
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },

    deleteFrom(height) {
      raw.query("DELETE FROM filter_headers WHERE height >= ?").run(height);
    },
  };

  const insertFilter = raw.query(
    `INSERT INTO filters (
       height, block_hash_internal_hex, filter
     ) VALUES (?, ?, ?)`,
  );
  const insertUnscanned = raw.query(
    `INSERT OR IGNORE INTO filters_unscanned (height) VALUES (?)`,
  );
  const deleteUnscannedOne = raw.query(
    `DELETE FROM filters_unscanned WHERE height = ?`,
  );
  const deleteUnscannedRange = raw.query(
    `DELETE FROM filters_unscanned WHERE height >= ? AND height <= ?`,
  );
  const listNeedingMatchStmt = raw.query(
    `SELECT f.height AS height,
            f.block_hash_internal_hex AS block_hash_internal_hex,
            f.filter AS filter
     FROM filters_unscanned u
     INNER JOIN filters f ON f.height = u.height
     ORDER BY u.height ASC
     LIMIT ?`,
  );
  const countFiltersStmt = raw.query(`SELECT COUNT(*) AS n FROM filters`);
  const countUnscannedStmt = raw.query(
    `SELECT COUNT(*) AS n FROM filters_unscanned`,
  );

  // COUNT(*) on fat/large tables is expensive — cache and adjust on mutations.
  let filterCountCache: number | null = null;
  let unscannedCountCache: number | null = null;
  function cachedFilterCount(): number {
    if (filterCountCache === null) {
      filterCountCache = (countFiltersStmt.get() as { n: number }).n;
    }
    return filterCountCache;
  }
  function cachedUnscannedCount(): number {
    if (unscannedCountCache === null) {
      unscannedCountCache = (countUnscannedStmt.get() as { n: number }).n;
    }
    return unscannedCountCache;
  }
  function bumpUnscannedCache(delta: number): void {
    if (unscannedCountCache !== null) unscannedCountCache += delta;
  }
  cachedFilterCount();
  cachedUnscannedCount();

  const filters: FiltersRepository = {
    count() {
      return cachedFilterCount();
    },

    countInRange(from, to) {
      const row = raw
        .query(
          `SELECT COUNT(*) AS n FROM filters
           WHERE height >= ? AND height <= ?`,
        )
        .get(from, to) as { n: number };
      return row.n;
    },

    minHeight() {
      const row = raw
        .query("SELECT MIN(height) AS h FROM filters")
        .get() as { h: number | null };
      return row.h ?? null;
    },

    maxHeight() {
      const row = raw
        .query("SELECT MAX(height) AS h FROM filters")
        .get() as { h: number | null };
      return row.h ?? null;
    },

    has(height) {
      const row = raw
        .query("SELECT 1 AS ok FROM filters WHERE height = ? LIMIT 1")
        .get(height) as { ok: number } | null;
      return row !== null;
    },

    get(height) {
      const row = raw
        .query(
          `SELECT height, block_hash_internal_hex, filter
           FROM filters WHERE height = ?`,
        )
        .get(height) as FilterRow | null;
      return row ? rowToFilter(row) : null;
    },

    firstHashMismatch(from, to) {
      if (to < from) return null;
      const row = raw
        .query(
          `SELECT f.height AS height
           FROM filters f
           INNER JOIN headers h ON h.height = f.height
           WHERE f.height >= ? AND f.height <= ?
             AND f.block_hash_internal_hex != h.hash_internal_hex
           ORDER BY f.height ASC
           LIMIT 1`,
        )
        .get(from, to) as { height: number } | null;
      return row?.height ?? null;
    },

    missingRanges(from, to, maxSpan) {
      if (to < from) return [];
      const span = Math.max(1, Math.floor(maxSpan));

      const pushChunks = (
        ranges: Array<{ from: number; to: number }>,
        start: number,
        end: number,
      ) => {
        for (let s = start; s <= end; ) {
          const e = Math.min(s + span - 1, end);
          ranges.push({ from: s, to: e });
          s = e + 1;
        }
      };

      // Solid [minH, maxH] → tip gaps only (avoid loading all heights).
      const minH = this.minHeight();
      const maxH = this.maxHeight();
      if (minH === null || maxH === null) {
        const ranges: Array<{ from: number; to: number }> = [];
        pushChunks(ranges, from, to);
        return ranges;
      }
      const count = cachedFilterCount();
      if (count > 0 && maxH - minH + 1 === count) {
        const ranges: Array<{ from: number; to: number }> = [];
        if (from < minH) pushChunks(ranges, from, Math.min(minH - 1, to));
        if (maxH < to) pushChunks(ranges, maxH + 1, to);
        return ranges;
      }

      // Walk present heights (O(rows)), not every height in [from, to].
      // A tip-span loop + Set blocked the event loop for hundreds of ms when
      // filters had internal gaps (quit/keypress starve).
      const rows = raw
        .query(
          `SELECT height FROM filters
           WHERE height >= ? AND height <= ?
           ORDER BY height ASC`,
        )
        .all(from, to) as Array<{ height: number }>;

      const ranges: Array<{ from: number; to: number }> = [];
      let expect = from;
      for (const { height } of rows) {
        if (height > expect) pushChunks(ranges, expect, height - 1);
        expect = height + 1;
      }
      if (expect <= to) pushChunks(ranges, expect, to);
      return ranges;
    },

    completeInRange(from, to) {
      if (to < from) return true;
      const minH = this.minHeight();
      const maxH = this.maxHeight();
      if (minH === null || maxH === null) return false;
      if (minH > from || maxH < to) return false;
      const count = cachedFilterCount();
      // Contiguous solid covering [minH, maxH] implies [from, to] is filled.
      return maxH - minH + 1 === count;
    },

    append(rows) {
      if (rows.length === 0) return;
      raw.exec("BEGIN");
      try {
        for (const row of rows) {
          insertFilter.run(
            row.height,
            row.blockHashInternalHex,
            row.filter,
          );
          insertUnscanned.run(row.height);
        }
        raw.exec("COMMIT");
        if (filterCountCache !== null) filterCountCache += rows.length;
        bumpUnscannedCache(rows.length);
      } catch (e) {
        raw.exec("ROLLBACK");
        filterCountCache = null;
        unscannedCountCache = null;
        throw e;
      }
    },

    listNeedingMatch(limit) {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      const rows = listNeedingMatchStmt.all(n) as FilterRow[];
      return rows.map((row) => rowToFilter(row));
    },

    countScanned() {
      return cachedFilterCount() - cachedUnscannedCount();
    },

    markScanned(heights) {
      if (heights.length === 0) return;
      const sorted = [...heights].sort((a, b) => a - b);
      const first = sorted[0]!;
      let contiguous = true;
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== first + i) {
          contiguous = false;
          break;
        }
      }
      // Delete from the small unscanned queue — never UPDATE fat filter rows.
      if (contiguous) {
        const result = deleteUnscannedRange.run(
          first,
          first + sorted.length - 1,
        );
        bumpUnscannedCache(-Number(result.changes));
        return;
      }
      raw.exec("BEGIN");
      try {
        let removed = 0;
        for (const height of sorted) {
          removed += Number(deleteUnscannedOne.run(height).changes);
        }
        raw.exec("COMMIT");
        bumpUnscannedCache(-removed);
      } catch (e) {
        raw.exec("ROLLBACK");
        unscannedCountCache = null;
        throw e;
      }
    },

    markUnscanned(heights) {
      if (heights.length === 0) return;
      raw.exec("BEGIN");
      try {
        let added = 0;
        for (const height of heights) {
          added += Number(insertUnscanned.run(height).changes);
        }
        raw.exec("COMMIT");
        bumpUnscannedCache(added);
      } catch (e) {
        raw.exec("ROLLBACK");
        unscannedCountCache = null;
        throw e;
      }
    },

    markUnscannedFrom(fromHeight) {
      const result = raw
        .query(
          `INSERT OR IGNORE INTO filters_unscanned (height)
           SELECT height FROM filters WHERE height >= ?`,
        )
        .run(fromHeight);
      bumpUnscannedCache(Number(result.changes));
    },

    deleteFrom(height) {
      raw.exec("BEGIN");
      try {
        raw.query("DELETE FROM filters_unscanned WHERE height >= ?").run(height);
        raw.query("DELETE FROM filters WHERE height >= ?").run(height);
        raw.exec("COMMIT");
        filterCountCache = null;
        unscannedCountCache = null;
      } catch (e) {
        raw.exec("ROLLBACK");
        filterCountCache = null;
        unscannedCountCache = null;
        throw e;
      }
    },
  };

  const insertMatchedBlock = raw.query(
    `INSERT OR IGNORE INTO matched_blocks (height, block_hash_internal_hex)
     VALUES (?, ?)`,
  );

  const matchedBlocks: MatchedBlocksRepository = {
    insert(block) {
      const result = insertMatchedBlock.run(
        block.height,
        block.blockHashInternalHex,
      );
      return result.changes > 0;
    },

    count() {
      const row = raw
        .query("SELECT COUNT(*) AS n FROM matched_blocks")
        .get() as { n: number };
      return row.n;
    },

    listNeedingDownload(limit) {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      const rows = raw
        .query(
          `SELECT m.height AS height,
                  m.block_hash_internal_hex AS block_hash_internal_hex
           FROM matched_blocks m
           LEFT JOIN blocks b ON b.height = m.height
           WHERE b.height IS NULL
           ORDER BY m.height ASC
           LIMIT ?`,
        )
        .all(n) as Array<{
        height: number;
        block_hash_internal_hex: string;
      }>;
      return rows.map((row) => ({
        height: row.height,
        blockHashInternalHex: row.block_hash_internal_hex,
      }));
    },
  };

  const insertBlock = raw.query(
    `INSERT OR IGNORE INTO blocks (height, block_hash_internal_hex, block)
     VALUES (?, ?, ?)`,
  );

  const blocks: BlocksRepository = {
    count() {
      const row = raw.query("SELECT COUNT(*) AS n FROM blocks").get() as {
        n: number;
      };
      return row.n;
    },

    has(height) {
      const row = raw
        .query("SELECT 1 AS ok FROM blocks WHERE height = ?")
        .get(height) as { ok: number } | null;
      return row !== null;
    },

    get(height) {
      const row = raw
        .query(
          `SELECT height, block_hash_internal_hex, block
           FROM blocks WHERE height = ?`,
        )
        .get(height) as {
        height: number;
        block_hash_internal_hex: string;
        block: Uint8Array;
      } | null;
      if (!row) return null;
      return {
        height: row.height,
        blockHashInternalHex: row.block_hash_internal_hex,
        block: row.block,
      };
    },

    insert(block) {
      const result = insertBlock.run(
        block.height,
        block.blockHashInternalHex,
        block.block,
      );
      return result.changes > 0;
    },

    listNeedingParse(limit) {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      const rows = raw
        .query(
          `SELECT b.height AS height,
                  b.block_hash_internal_hex AS block_hash_internal_hex,
                  b.block AS block
           FROM blocks b
           LEFT JOIN parsed_blocks p ON p.height = b.height
           WHERE p.height IS NULL
           ORDER BY b.height ASC
           LIMIT ?`,
        )
        .all(n) as Array<{
        height: number;
        block_hash_internal_hex: string;
        block: Uint8Array;
      }>;
      return rows.map((row) => ({
        height: row.height,
        blockHashInternalHex: row.block_hash_internal_hex,
        block: row.block,
      }));
    },

    findHeightsContainingOutpoint(txidDisplay, vout, afterHeight) {
      const pattern = Buffer.alloc(36);
      Buffer.from(txidDisplay, "hex").reverse().copy(pattern, 0);
      pattern.writeUInt32LE(vout >>> 0, 32);
      const rows = raw
        .query(
          `SELECT height AS height
           FROM blocks
           WHERE height > ?
             AND instr(block, ?) > 0
           ORDER BY height ASC`,
        )
        .all(afterHeight, pattern) as Array<{ height: number }>;
      return rows.map((row) => row.height);
    },
  };

  const insertParsedBlock = raw.query(
    `INSERT OR IGNORE INTO parsed_blocks (height) VALUES (?)`,
  );

  const parsedBlocks: ParsedBlocksRepository = {
    has(height) {
      const row = raw
        .query("SELECT 1 AS ok FROM parsed_blocks WHERE height = ? LIMIT 1")
        .get(height) as { ok: number } | null;
      return row !== null;
    },

    mark(height) {
      insertParsedBlock.run(height);
    },

    count() {
      const row = raw
        .query("SELECT COUNT(*) AS n FROM parsed_blocks")
        .get() as { n: number };
      return row.n;
    },

    clearFrom(fromHeight) {
      raw
        .query("DELETE FROM parsed_blocks WHERE height >= ?")
        .run(fromHeight);
    },

    clear(height) {
      raw.query("DELETE FROM parsed_blocks WHERE height = ?").run(height);
    },
  };

  const upsertTransaction = raw.query(
    `INSERT INTO transactions (
       txid, height, tx_index, block_hash_internal_hex, tx, net_delta_sats
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(txid) DO UPDATE SET
       height = excluded.height,
       tx_index = excluded.tx_index,
       block_hash_internal_hex = excluded.block_hash_internal_hex,
       tx = excluded.tx,
       net_delta_sats = excluded.net_delta_sats`,
  );

  const setNetDeltaStmt = raw.query(
    `UPDATE transactions SET net_delta_sats = ? WHERE txid = ?`,
  );

  type TxRow = {
    txid: string;
    height: number;
    tx_index: number;
    block_hash_internal_hex: string;
    tx: Uint8Array;
    net_delta_sats: number;
  };

  function rowToStoredTx(row: TxRow): StoredTx {
    return {
      txid: row.txid,
      height: row.height,
      txIndex: row.tx_index,
      blockHashInternalHex: row.block_hash_internal_hex,
      tx: row.tx,
      netDeltaSats: row.net_delta_sats,
    };
  }

  const getKeyValue = raw.query(
    `SELECT value FROM key_value WHERE key = ?`,
  );
  const setKeyValue = raw.query(
    `INSERT INTO key_value(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const keyValue: KeyValueRepository = {
    get(key) {
      const row = getKeyValue.get(key) as { value: string } | null;
      return row?.value ?? null;
    },

    set(key, value) {
      setKeyValue.run(key, value);
    },
  };

  const getUtxoName = raw.query(
    `SELECT name FROM utxo_names WHERE outpoint = ?`,
  );
  const upsertUtxoName = raw.query(
    `INSERT INTO utxo_names(outpoint, name) VALUES (?, ?)
     ON CONFLICT(outpoint) DO UPDATE SET name = excluded.name`,
  );
  const deleteUtxoName = raw.query(
    `DELETE FROM utxo_names WHERE outpoint = ?`,
  );
  const listUtxoNames = raw.query(
    `SELECT outpoint, name FROM utxo_names ORDER BY outpoint`,
  );

  const utxoNames: UtxoNamesRepository = {
    get(outpoint) {
      const row = getUtxoName.get(outpoint) as { name: string } | null;
      return row?.name ?? null;
    },
    upsert(outpoint, name) {
      upsertUtxoName.run(outpoint, name);
    },
    delete(outpoint) {
      deleteUtxoName.run(outpoint);
    },
    list() {
      return listUtxoNames.all() as { outpoint: string; name: string }[];
    },
  };

  const transactions: TransactionsRepository = {
    upsert(tx) {
      upsertTransaction.run(
        tx.txid,
        tx.height,
        tx.txIndex,
        tx.blockHashInternalHex,
        tx.tx,
        tx.netDeltaSats,
      );
    },

    list() {
      const rows = raw
        .query(
          `SELECT txid, height, tx_index, block_hash_internal_hex, tx, net_delta_sats
           FROM transactions
           ORDER BY height DESC, tx_index DESC`,
        )
        .all() as TxRow[];
      return rows.map(rowToStoredTx);
    },

    count() {
      const row = raw
        .query("SELECT COUNT(*) AS n FROM transactions")
        .get() as { n: number };
      return row.n;
    },

    minHeight() {
      const row = raw
        .query("SELECT MIN(height) AS h FROM transactions")
        .get() as { h: number | null };
      return row.h ?? null;
    },

    setNetDelta(txid, netDeltaSats) {
      setNetDeltaStmt.run(netDeltaSats, txid);
    },
  };

  return {
    peers,
    headers,
    filterHeaders,
    filters,
    matchedBlocks,
    blocks,
    parsedBlocks,
    transactions,
    keyValue,
    utxoNames,
    close() {
      raw.close();
    },
  };
}
