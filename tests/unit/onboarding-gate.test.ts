import { describe, expect, test } from "bun:test";
import { resolveOnboardingGate } from "../../src/boot/onboarding-gate.ts";

describe("resolveOnboardingGate", () => {
  test("invalid secret always exits", () => {
    expect(
      resolveOnboardingGate(
        { status: "invalid", detail: "bad" },
        { status: "ok", year: 2019 },
      ),
    ).toEqual({ action: "exit-invalid", detail: "bad" });
  });

  test("missing secret → full onboarding", () => {
    expect(
      resolveOnboardingGate({ status: "missing" }, { status: "missing" }),
    ).toEqual({ action: "onboard", startAtYearStep: false });
  });

  test("secret ok + year missing → year step only", () => {
    expect(
      resolveOnboardingGate(
        { status: "ok", value: "zpub…" },
        { status: "missing" },
      ),
    ).toEqual({ action: "onboard", startAtYearStep: true });
  });

  test("plain secret + year ok → encrypt screen", () => {
    expect(
      resolveOnboardingGate(
        { status: "ok", value: "zpub…" },
        { status: "ok", year: 2015 },
      ),
    ).toEqual({ action: "encrypt" });
  });

  test("encrypted secret + year ok → unlock", () => {
    expect(
      resolveOnboardingGate(
        { status: "encrypted" },
        { status: "ok", year: 2015 },
      ),
    ).toEqual({ action: "unlock" });
  });

  test("encrypted secret + year missing → year step first", () => {
    expect(
      resolveOnboardingGate({ status: "encrypted" }, { status: "missing" }),
    ).toEqual({ action: "onboard", startAtYearStep: true });
  });
});
