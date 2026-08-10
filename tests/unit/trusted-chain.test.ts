import { describe, expect, test } from "bun:test";
import {
  CHECKPOINT_DISPLAY_HASH,
  checkpointDbRecord,
  checkpointSeedRecord,
  BLUEBERRY_HEADER_CONSENSUS,
} from "../../src/checkpoint.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  TRUSTED_CHAIN_WINDOW,
  trustedChainFromStored,
} from "../../src/headers/trusted-chain.ts";

describe("trustedChainFromStored", () => {
  test("loads checkpoint without consensus re-validation", () => {
    const db = createSqliteDatabase(":memory:");
    const seed = checkpointSeedRecord();
    db.headers.ensureCheckpoint(checkpointDbRecord());
    const chain = trustedChainFromStored(db.headers.loadAll(), BLUEBERRY_HEADER_CONSENSUS);
    expect(chain.tipHeight).toBe(seed.height);
    expect(chain.tipHashDisplay).toBe(CHECKPOINT_DISPLAY_HASH);
    expect(chain.chainWork).toBe(db.headers.tip()!.cumulativeWork);
    expect(TRUSTED_CHAIN_WINDOW).toBeGreaterThan(2016);
    db.close();
  });
});
