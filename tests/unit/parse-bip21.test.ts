import { describe, expect, test } from "bun:test";
import { parseBip21 } from "../../src/parse/bip21.ts";

const ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

describe("parseBip21", () => {
  test("parses address only", () => {
    expect(parseBip21(`bitcoin:${ADDR}`)).toEqual({
      address: ADDR,
      amount: null,
      label: null,
    });
  });

  test("parses amount", () => {
    expect(parseBip21(`bitcoin:${ADDR}?amount=0.01`)).toEqual({
      address: ADDR,
      amount: "0.01",
      label: null,
    });
  });

  test("parses label", () => {
    expect(parseBip21(`bitcoin:${ADDR}?label=rent`)).toEqual({
      address: ADDR,
      amount: null,
      label: "rent",
    });
  });

  test("uses message when label is absent", () => {
    expect(parseBip21(`bitcoin:${ADDR}?message=lunch`)).toEqual({
      address: ADDR,
      amount: null,
      label: "lunch",
    });
  });

  test("label wins over message", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?label=rent&message=lunch`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "rent",
    });
  });

  test("percent-decodes label and message", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?label=foo%20bar%26baz`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "foo bar&baz",
    });
    expect(
      parseBip21(`bitcoin:${ADDR}?message=hello%20world`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "hello world",
    });
  });

  test("keeps plus signs in query values", () => {
    expect(parseBip21(`bitcoin:${ADDR}?label=a+b`)).toEqual({
      address: ADDR,
      amount: null,
      label: "a+b",
    });
  });

  test("accepts BITCOIN: and optional //", () => {
    expect(parseBip21(`BITCOIN:${ADDR}`)).toEqual({
      address: ADDR,
      amount: null,
      label: null,
    });
    expect(parseBip21(`bitcoin://${ADDR}`)).toEqual({
      address: ADDR,
      amount: null,
      label: null,
    });
  });

  test("unknown req- param returns null", () => {
    expect(parseBip21(`bitcoin:${ADDR}?req-foo=1`)).toBeNull();
  });

  test("known req-amount and req-label still parse", () => {
    expect(parseBip21(`bitcoin:${ADDR}?req-amount=0.5`)).toEqual({
      address: ADDR,
      amount: "0.5",
      label: null,
    });
    expect(parseBip21(`bitcoin:${ADDR}?req-label=rent`)).toEqual({
      address: ADDR,
      amount: null,
      label: "rent",
    });
  });

  test("lightning-only URI returns null", () => {
    expect(parseBip21("bitcoin:?lightning=lnbc1dummy")).toBeNull();
  });

  test("not a URI returns null", () => {
    expect(parseBip21(ADDR)).toBeNull();
    expect(parseBip21("")).toBeNull();
    expect(parseBip21("  ")).toBeNull();
  });

  test("bad amount still returns address and label", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?amount=abc&label=rent`),
    ).toEqual({
      address: ADDR,
      amount: "abc",
      label: "rent",
    });
  });

  test("empty label falls back to message", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?label=&message=lunch`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "lunch",
    });
    expect(
      parseBip21(`bitcoin:${ADDR}?label=%20&message=lunch`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "lunch",
    });
  });

  test("trims whitespace around the whole URI", () => {
    expect(parseBip21(`  bitcoin:${ADDR}?amount=1  `)).toEqual({
      address: ADDR,
      amount: "1",
      label: null,
    });
  });

  test("drops a badly encoded query pair and parses the rest", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?label=%ZZ&amount=0.01`),
    ).toEqual({
      address: ADDR,
      amount: "0.01",
      label: null,
    });
  });

  test("empty amount param is present as empty string", () => {
    expect(parseBip21(`bitcoin:${ADDR}?amount=`)).toEqual({
      address: ADDR,
      amount: "",
      label: null,
    });
  });

  test("bitcoin: with no address returns null", () => {
    expect(parseBip21("bitcoin:")).toBeNull();
    expect(parseBip21("bitcoin://")).toBeNull();
  });
});
