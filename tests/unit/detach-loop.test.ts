import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { closeFileLog } from "../../src/log.ts";
import { detachLoop } from "../../src/modules/detach-loop.ts";

describe("detachLoop", () => {
  test("emits module:status error and does not reject", async () => {
    closeFileLog();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const statuses: Array<{ status: string; detail?: string }> = [];
    bus.on("module:status", (p) => {
      statuses.push({ status: p.status, detail: p.detail });
    });

    await detachLoop(
      { bus, db },
      "chain-headers",
      Promise.reject(new Error("boom")),
    );

    expect(statuses).toEqual([
      { status: "error", detail: "boom" },
    ]);
    db.close();
  });

  test("resolves when the task succeeds", async () => {
    closeFileLog();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    let seen = 0;
    bus.on("module:status", () => {
      seen++;
    });

    await detachLoop({ bus, db }, "blocks-download", Promise.resolve());
    expect(seen).toBe(0);
    db.close();
  });
});
