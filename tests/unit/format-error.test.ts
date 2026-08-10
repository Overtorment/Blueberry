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
});
