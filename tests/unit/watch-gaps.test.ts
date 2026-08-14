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

  test("load clamps absurd persisted watch counts", () => {
    const db = createSqliteDatabase(":memory:");
    db.keyValue.set("watch_external", "1000000000");
    db.keyValue.set("watch_internal", "-1");
    expect(loadWatchGaps(db)).toEqual({
      external: 10_000,
      internal: config.initialWatchCount,
    });
    expect(db.keyValue.get("watch_external")).toBe("10000");
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

  test("growth stops at the watch cap so rematch cannot loop", () => {
    const atCap = growWatchGapsIfNeeded(
      { external: 10_000, internal: 10_000 },
      { external: [9_999], internal: [] },
      100,
    );
    expect(atCap.grew).toBe(false);
    expect(atCap.gaps).toEqual({ external: 10_000, internal: 10_000 });

    const nearCap = growWatchGapsIfNeeded(
      { external: 9_950, internal: 40 },
      { external: [9_900], internal: [] },
      100,
    );
    expect(nearCap.grew).toBe(true);
    expect(nearCap.gaps).toEqual({ external: 10_000, internal: 40 });
  });
});
