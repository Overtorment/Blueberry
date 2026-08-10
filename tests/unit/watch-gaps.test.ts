import { describe, expect, test } from "bun:test";
import { config } from "../../src/config.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  growWatchGapsIfNeeded,
  loadWatchGaps,
  saveWatchGaps,
} from "../../src/wallet/watch-gaps.ts";

describe("watch gaps", () => {
  test("load defaults and persists", () => {
    const db = createSqliteDatabase(":memory:");
    expect(loadWatchGaps(db)).toEqual({
      external: config.initialWatchCount,
      internal: config.initialWatchCount,
    });
    expect(db.keyValue.get("watch_external")).toBe(
      String(config.initialWatchCount),
    );
    expect(db.keyValue.get("watch_internal")).toBe(
      String(config.initialWatchCount),
    );
    saveWatchGaps(db, { external: 60, internal: 40 });
    expect(loadWatchGaps(db)).toEqual({ external: 60, internal: 40 });
    db.close();
  });

  test("grows when used index in danger zone", () => {
    const r = growWatchGapsIfNeeded(
      { external: 40, internal: 40 },
      { external: [25], internal: [] },
      20,
    );
    expect(r.grew).toBe(true);
    expect(r.gaps).toEqual({ external: 60, internal: 40 });
  });

  test("no grow when used only below danger zone", () => {
    const r = growWatchGapsIfNeeded(
      { external: 40, internal: 40 },
      { external: [19], internal: [10] },
      20,
    );
    expect(r.grew).toBe(false);
    expect(r.gaps).toEqual({ external: 40, internal: 40 });
  });

  test("internal danger zone grows independently", () => {
    const r = growWatchGapsIfNeeded(
      { external: 40, internal: 40 },
      { external: [], internal: [30] },
      20,
    );
    expect(r.gaps).toEqual({ external: 40, internal: 60 });
  });
});
