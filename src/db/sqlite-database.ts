import { constants, Database as BunDatabase } from "bun:sqlite";
import {
  decodeBlockHeader,
  decodeCompactTarget,
  equalBytes,
  headerWork,
  MAINNET_POW_LIMIT,
} from "bitcoin-headers";
import { fromSqliteServices, toSqliteServices } from "./peer-services.ts";
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

/** Bun `safeIntegers` returns INTEGER columns as bigint. */
function asInt(value: bigint | number): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function asIntOrNull(value: bigint | number | null): number | null {
  return value === null ? null : asInt(value);
}

type PeerRow = {
  host: string;
  port: bigint | number;
  services: bigint | number | string;
  alive: bigint | number;
  used_for_blocks: bigint | number;
  last_probed_at: bigint | number | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

type HeaderRow = {
  height: bigint | number;
  hash_internal_hex: string;
  header: Uint8Array;
  cumulative_work: string;
};

type FilterHeaderRow = {
  height: bigint | number;
  header: Uint8Array;
};

type FilterRow = {
  height: bigint | number;
  block_hash_internal_hex: string;
  filter: Uint8Array;
};

function rowToFilterHeader(row: FilterHeaderRow): FilterHeaderRecord {
  return {
    height: asInt(row.height),
    header: row.header,
  };
}

function rowToFilter(row: FilterRow): FilterRecord {
  return {
    height: asInt(row.height),
    blockHashInternalHex: row.block_hash_internal_hex,
    filter: row.filter,
  };
}

function rowToHeader(row: HeaderRow): StoredHeader {
  return {
    height: asInt(row.height),
    hashInternalHex: row.hash_internal_hex,
    header: row.header,
    cumulativeWork: BigInt(row.cumulative_work),
  };
}

function rowToPeer(row: PeerRow): Peer {
  return {
    host: row.host,
    port: asInt(row.port),
    services: fromSqliteServices(row.services),
    alive: asInt(row.alive) === 1,
    usedForBlocks: asInt(row.used_for_blocks) === 1,
    lastProbedAt: asIntOrNull(row.last_probed_at),
    createdAt: asInt(row.created_at),
    updatedAt: asInt(row.updated_at),
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
  // Required so peer services (full signed i64) round-trip without Number truncation.
  const raw = new BunDatabase(path, { safeIntegers: true });
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

  function inTx(fn: () => void): void {
    if (raw.inTransaction) {
      fn();
      return;
    }
    raw.transaction(fn)();
  }

  // COUNT(*) on fat/large tables is expensive — cache and adjust on mutations.
  let filterCountCache: number | null = null;
  let unscannedCountCache: number | null = null;

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
            services = CASE
              WHEN excluded.services != 0 THEN excluded.services
              ELSE services
            END,
            updated_at = excluded.updated_at`,
        )
        .run(
          peer.host,
          peer.port,
          toSqliteServices(peer.services),
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
        n: bigint | number;
      };
      return asInt(row.n);
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
      const mask = toSqliteServices(serviceBits);
      const unused = options?.unusedForBlocks === true;
      const rows = (
        unused
          ? raw.query(
              `SELECT * FROM peers
               WHERE alive = 1
                 AND used_for_blocks = 0
                 AND (services & ?) != 0
               ORDER BY host, port
               LIMIT ?`,
            )
          : raw.query(
              `SELECT * FROM peers
               WHERE alive = 1
                 AND (services & ?) != 0
               ORDER BY host, port
               LIMIT ?`,
            )
      ).all(mask, n) as PeerRow[];
      return rows.map(rowToPeer);
    },

    listWithServices(serviceBits, limit) {
      const n = Math.max(0, Math.floor(limit));
      if (n === 0) return [];
      const mask = toSqliteServices(serviceBits);
      const rows = raw
        .query(
          `SELECT * FROM peers
           WHERE (services & ?) != 0
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
        n: bigint | number;
      };
      return asInt(row.n);
    },

    minHeight() {
      const row = raw
        .query("SELECT MIN(height) AS h FROM headers")
        .get() as { h: bigint | number | null };
      return asIntOrNull(row.h);
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
        .get(hashInternalHex) as { height: bigint | number } | null;
      return row ? asInt(row.height) : null;
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
      inTx(() => {
        insertWrites(headerRecords, tip?.cumulativeWork ?? 0n);
      });
    },

    replaceAfter(commonAncestorHeight, headerRecords) {
      inTx(() => {
        raw
          .query("DELETE FROM headers WHERE height > ?")
          .run(commonAncestorHeight);
        const ancestor = this.get(commonAncestorHeight);
        insertWrites(headerRecords, ancestor?.cumulativeWork ?? 0n);
      });
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
        .get() as { h: bigint | number | null };
      return asIntOrNull(row.h);
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
      inTx(() => {
        for (const row of rows) {
          insertFilterHeader.run(row.height, row.header);
        }
      });
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
  const filterHashAtStmt = raw.query(
    `SELECT block_hash_internal_hex AS h FROM filters WHERE height = ?`,
  );

  function cachedFilterCount(): number {
    if (filterCountCache === null) {
      filterCountCache = asInt(
        (countFiltersStmt.get() as { n: bigint | number }).n,
      );
    }
    return filterCountCache;
  }
  function cachedUnscannedCount(): number {
    if (unscannedCountCache === null) {
      unscannedCountCache = asInt(
        (countUnscannedStmt.get() as { n: bigint | number }).n,
      );
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
        .get(from, to) as { n: bigint | number };
      return asInt(row.n);
    },

    minHeight() {
      const row = raw
        .query("SELECT MIN(height) AS h FROM filters")
        .get() as { h: bigint | number | null };
      return asIntOrNull(row.h);
    },

    maxHeight() {
      const row = raw
        .query("SELECT MAX(height) AS h FROM filters")
        .get() as { h: bigint | number | null };
      return asIntOrNull(row.h);
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

    hashAt(height) {
      const row = filterHashAtStmt.get(height) as { h: string } | null;
      return row?.h ?? null;
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
        .get(from, to) as { height: bigint | number } | null;
      return row ? asInt(row.height) : null;
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
        if (maxH < to) pushChunks(ranges, Math.max(maxH + 1, from), to);
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
        .all(from, to) as Array<{ height: bigint | number }>;

      const ranges: Array<{ from: number; to: number }> = [];
      let expect = from;
      for (const row of rows) {
        const height = asInt(row.height);
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
      // Contiguous [minH, maxH] implies [from, to] is filled.
      if (maxH - minH + 1 === count) return true;
      // Prefix/other holes outside the span: PK count, not the filter blobs.
      return this.countInRange(from, to) === to - from + 1;
    },

    append(rows) {
      if (rows.length === 0) return;
      try {
        inTx(() => {
          for (const row of rows) {
            insertFilter.run(
              row.height,
              row.blockHashInternalHex,
              row.filter,
            );
            insertUnscanned.run(row.height);
          }
        });
        if (filterCountCache !== null) filterCountCache += rows.length;
        bumpUnscannedCache(rows.length);
      } catch (e) {
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
      try {
        let removed = 0;
        inTx(() => {
          for (const height of sorted) {
            removed += Number(deleteUnscannedOne.run(height).changes);
          }
        });
        bumpUnscannedCache(-removed);
      } catch (e) {
        unscannedCountCache = null;
        throw e;
      }
    },

    markUnscanned(heights) {
      if (heights.length === 0) return;
      try {
        let added = 0;
        inTx(() => {
          for (const height of heights) {
            added += Number(insertUnscanned.run(height).changes);
          }
        });
        bumpUnscannedCache(added);
      } catch (e) {
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
      try {
        inTx(() => {
          raw
            .query("DELETE FROM filters_unscanned WHERE height >= ?")
            .run(height);
          raw.query("DELETE FROM filters WHERE height >= ?").run(height);
        });
        filterCountCache = null;
        unscannedCountCache = null;
      } catch (e) {
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

    get(height) {
      const row = raw
        .query(
          `SELECT height, block_hash_internal_hex
           FROM matched_blocks WHERE height = ?`,
        )
        .get(height) as {
        height: bigint | number;
        block_hash_internal_hex: string;
      } | null;
      if (!row) return null;
      return {
        height: asInt(row.height),
        blockHashInternalHex: row.block_hash_internal_hex,
      };
    },

    count() {
      const row = raw
        .query("SELECT COUNT(*) AS n FROM matched_blocks")
        .get() as { n: bigint | number };
      return asInt(row.n);
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
        height: bigint | number;
        block_hash_internal_hex: string;
      }>;
      return rows.map((row) => ({
        height: asInt(row.height),
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
        n: bigint | number;
      };
      return asInt(row.n);
    },

    has(height) {
      const row = raw
        .query("SELECT 1 AS ok FROM blocks WHERE height = ?")
        .get(height) as { ok: bigint | number } | null;
      return row !== null;
    },

    get(height) {
      const row = raw
        .query(
          `SELECT height, block_hash_internal_hex, block
           FROM blocks WHERE height = ?`,
        )
        .get(height) as {
        height: bigint | number;
        block_hash_internal_hex: string;
        block: Uint8Array;
      } | null;
      if (!row) return null;
      return {
        height: asInt(row.height),
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
        height: bigint | number;
        block_hash_internal_hex: string;
        block: Uint8Array;
      }>;
      return rows.map((row) => ({
        height: asInt(row.height),
        blockHashInternalHex: row.block_hash_internal_hex,
        block: row.block,
      }));
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
        .get() as { n: bigint | number };
      return asInt(row.n);
    },

    clearFrom(fromHeight) {
      raw
        .query("DELETE FROM parsed_blocks WHERE height >= ?")
        .run(fromHeight);
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
    height: bigint | number;
    tx_index: bigint | number;
    block_hash_internal_hex: string;
    tx: Uint8Array;
    net_delta_sats: bigint | number;
  };

  function rowToStoredTx(row: TxRow): StoredTx {
    return {
      txid: row.txid,
      height: asInt(row.height),
      txIndex: asInt(row.tx_index),
      blockHashInternalHex: row.block_hash_internal_hex,
      tx: row.tx,
      netDeltaSats: asInt(row.net_delta_sats),
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
        .get() as { n: bigint | number };
      return asInt(row.n);
    },

    fingerprint() {
      const row = raw
        .query(
          `SELECT
             COUNT(*) AS n,
             COALESCE(SUM(net_delta_sats), 0) AS s,
             (SELECT txid FROM transactions
              ORDER BY height DESC, tx_index DESC LIMIT 1) AS newest
           FROM transactions`,
        )
        .get() as {
        n: bigint | number;
        s: bigint | number;
        newest: string | null;
      };
      return {
        count: asInt(row.n),
        netDeltaSum: asInt(row.s),
        newestTxid: row.newest,
      };
    },

    minHeight() {
      const row = raw
        .query("SELECT MIN(height) AS h FROM transactions")
        .get() as { h: bigint | number | null };
      return asIntOrNull(row.h);
    },

    get(txid) {
      const row = raw
        .query(
          `SELECT txid, height, tx_index, block_hash_internal_hex, tx, net_delta_sats
           FROM transactions WHERE txid = ?`,
        )
        .get(txid) as TxRow | null;
      return row ? rowToStoredTx(row) : null;
    },

    setNetDelta(txid, netDeltaSats) {
      setNetDeltaStmt.run(netDeltaSats, txid);
    },
  };

  function rewindAfter(ancestorHeight: number): void {
    inTx(() => {
      raw
        .query("DELETE FROM filter_headers WHERE height > ?")
        .run(ancestorHeight);
      raw
        .query("DELETE FROM filters_unscanned WHERE height > ?")
        .run(ancestorHeight);
      raw.query("DELETE FROM filters WHERE height > ?").run(ancestorHeight);
      raw
        .query("DELETE FROM matched_blocks WHERE height > ?")
        .run(ancestorHeight);
      raw.query("DELETE FROM blocks WHERE height > ?").run(ancestorHeight);
      raw
        .query("DELETE FROM parsed_blocks WHERE height > ?")
        .run(ancestorHeight);
      raw
        .query("DELETE FROM transactions WHERE height > ?")
        .run(ancestorHeight);
      filterCountCache = null;
      unscannedCountCache = null;
    });
  }

  function wipeFiltersFrom(
    height: number,
    options?: { prevHeaderHeight?: number },
  ): void {
    inTx(() => {
      raw.query("DELETE FROM filters_unscanned WHERE height >= ?").run(height);
      raw.query("DELETE FROM filters WHERE height >= ?").run(height);
      raw.query("DELETE FROM filter_headers WHERE height >= ?").run(height);
      if (options?.prevHeaderHeight !== undefined) {
        raw
          .query("DELETE FROM filter_headers WHERE height = ?")
          .run(options.prevHeaderHeight);
      }
      filterCountCache = null;
      unscannedCountCache = null;
    });
  }

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
    transaction(fn) {
      inTx(fn);
    },
    rewindAfter,
    wipeFiltersFrom,
    close() {
      raw.close();
    },
  };
}
