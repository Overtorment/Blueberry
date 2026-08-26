import { describe, expect, test } from "bun:test";
import { config } from "../../src/config.ts";
import {
  HEADER_WATCHER_FILL_MS,
  atTipWaitMs,
  ignoreQuietPeerKick,
  lostLastWatcher,
} from "../../src/modules/chain-headers.ts";

describe("header offline recover policy", () => {
  test("at tip naps when any watcher is live", () => {
    const idle = config.headerIdleCheckMs;
    expect(atTipWaitMs(idle, true)).toBe(idle);
    expect(atTipWaitMs(idle, false)).toBe(HEADER_WATCHER_FILL_MS);
  });

  test("quiet peer kicks are ignored only while a watcher is up", () => {
    expect(ignoreQuietPeerKick(true, false, true)).toBe(true);
    expect(ignoreQuietPeerKick(true, false, false)).toBe(false);
    expect(ignoreQuietPeerKick(true, true, true)).toBe(false);
    expect(ignoreQuietPeerKick(false, false, true)).toBe(false);
  });

  test("last watcher drop is the offline edge", () => {
    expect(lostLastWatcher(1, 0)).toBe(true);
    expect(lostLastWatcher(0, 0)).toBe(false);
    expect(lostLastWatcher(4, 3)).toBe(false);
  });
});
