import type { Database as BunDatabase } from "bun:sqlite";

export function ensureSchema(raw: BunDatabase): void {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      services INTEGER NOT NULL DEFAULT 0,
      alive INTEGER NOT NULL DEFAULT 0,
      used_for_blocks INTEGER NOT NULL DEFAULT 0,
      last_probed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (host, port)
    );

    CREATE TABLE IF NOT EXISTS headers (
      height INTEGER PRIMARY KEY,
      hash_internal_hex TEXT NOT NULL,
      header BLOB NOT NULL,
      cumulative_work TEXT NOT NULL DEFAULT '0'
    );

    CREATE TABLE IF NOT EXISTS filter_headers (
      height INTEGER PRIMARY KEY,
      header BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS filters (
      height INTEGER PRIMARY KEY,
      block_hash_internal_hex TEXT NOT NULL,
      filter BLOB NOT NULL
    );

    -- Tiny queue of heights still needing match. Marking scanned DELETEs here
    -- instead of UPDATEing filters rows (those carry ~45KB filter and would
    -- amplify the WAL by rewriting the blob on every scan progress write).
    CREATE TABLE IF NOT EXISTS filters_unscanned (
      height INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS matched_blocks (
      height INTEGER PRIMARY KEY,
      block_hash_internal_hex TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER PRIMARY KEY,
      block_hash_internal_hex TEXT NOT NULL,
      block BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parsed_blocks (
      height INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS transactions (
      txid TEXT PRIMARY KEY,
      height INTEGER NOT NULL,
      tx_index INTEGER NOT NULL,
      block_hash_internal_hex TEXT NOT NULL,
      tx BLOB NOT NULL,
      net_delta_sats INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS key_value (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS utxo_names (
      outpoint TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS headers_hash_internal_hex
      ON headers(hash_internal_hex);
    CREATE INDEX IF NOT EXISTS filters_height_hash
      ON filters(height, block_hash_internal_hex);
    CREATE INDEX IF NOT EXISTS peers_alive_used
      ON peers(alive, used_for_blocks);
    CREATE INDEX IF NOT EXISTS peers_probe_queue
      ON peers(
        CASE WHEN last_probed_at IS NULL THEN 0 ELSE 1 END,
        last_probed_at,
        CASE WHEN instr(host, ':') > 0 THEN 1 ELSE 0 END,
        host,
        port
      );
    CREATE INDEX IF NOT EXISTS peers_service_queue
      ON peers(
        alive DESC,
        CASE WHEN last_probed_at IS NULL THEN 0 ELSE 1 END,
        last_probed_at,
        host,
        port
      );
  `);
}
