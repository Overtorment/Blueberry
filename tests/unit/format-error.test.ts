import { describe, expect, test } from "bun:test";
import { formatError } from "../../src/net/format-error.ts";

describe("formatError", () => {
  test("walks cause chain", () => {
    const err = new Error("Errored", { cause: new Error("connection reset") });
    err.name = "CascadeError";
    expect(formatError(err)).toBe(
      "CascadeError: Errored ← connection reset",
    );
  });

  test("reads reason on plain objects", () => {
    expect(formatError({ message: "Errored", reason: "stream closed" })).toBe(
      "Errored ← stream closed",
    );
  });

  test("unwraps AggregateError.errors so directory races show the real failure", () => {
    expect(
      formatError(
        new AggregateError(
          [new Error("Missing version"), new Error("Missing version")],
          "fetchFirstOk: all failed",
        ),
      ),
    ).toBe("AggregateError: fetchFirstOk: all failed ← Missing version");
  });
});
