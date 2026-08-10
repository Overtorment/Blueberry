import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createFiltersMatchingModule } from "../../src/modules/filters-matching.ts";
import { createParseBlocksModule } from "../../src/modules/parse-blocks.ts";
import { config } from "../../src/config.ts";
import { saveWalletSecret } from "../../src/wallet/secret.ts";
import { createWallet } from "../../src/wallet/wallet.ts";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const BLUE_EXTERNAL_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

describe("modules + injected wallet", () => {
  test("parse-blocks uses KV-backed wallet (known first address)", async () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ABANDON);
    const bus = createMessageBus();
    const wallet = createWallet(db);
    expect(wallet.snapshot().addresses[0]?.address).toBe(BLUE_EXTERNAL_0);

    const mod = createParseBlocksModule(
      { bus, db },
      { wallet, idleDelayMs: 50, blockGapMs: 0 },
    );
    await mod.start();
    expect(wallet.gaps()).toEqual({
      external: config.initialWatchCount,
      internal: config.initialWatchCount,
    });
    await mod.stop();
    db.close();
  });

  test("filters-matching uses KV-backed wallet (known first address)", async () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ABANDON);
    const bus = createMessageBus();
    const wallet = createWallet(db);
    expect(wallet.snapshot().addresses[0]?.address).toBe(BLUE_EXTERNAL_0);

    const mod = createFiltersMatchingModule(
      { bus, db },
      { wallet, batchGapMs: 0 },
    );
    await mod.start();
    expect(wallet.scripts()).toHaveLength(config.initialWatchCount * 2);
    await mod.stop();
    db.close();
  });
});
