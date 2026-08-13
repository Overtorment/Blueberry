import { describe, expect, test } from "bun:test";
import {
  decodeBlockHeader,
  headerHashDisplay,
  headerHashInternal,
  hexToBytes,
  meetsTarget,
  validateHeaderChain,
} from "bitcoin-headers";
import {
  CHECKPOINT_HEIGHT,
  CHECKPOINTS,
  DEFAULT_CHECKPOINT_YEAR,
  BLUEBERRY_HEADER_CONSENSUS,
  checkpointForYear,
  checkpointSeedRecord,
  consensusForYear,
} from "../../src/checkpoint.ts";

/** Well-known mainnet genesis display hash — not copied from our bake table. */
const GENESIS_DISPLAY_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

describe("year checkpoints", () => {
  test("2009–2026 entries obey retarget + Jan-1 rule and pass PoW", () => {
    const years = Object.keys(CHECKPOINTS)
      .map(Number)
      .sort((a, b) => a - b);
    expect(years[0]).toBe(2009);
    expect(years.at(-1)).toBe(2026);
    expect(years).toHaveLength(2026 - 2009 + 1);

    for (const year of years) {
      const entry = checkpointForYear(year);
      expect(entry.name).toBe(String(year));
      expect(entry.height % 2016).toBe(0);
      expect(entry.previousTimestamps).toHaveLength(
        Math.min(10, entry.height),
      );

      const header = decodeBlockHeader(hexToBytes(entry.headerHex));
      expect(meetsTarget(headerHashInternal(header), header.bits)).toBe(true);

      if (year === 2009) {
        expect(entry.height).toBe(0);
        expect(headerHashDisplay(header)).toBe(GENESIS_DISPLAY_HASH);
        expect(entry.previousTimestamps).toEqual([]);
      } else {
        expect(header.timestamp).toBeLessThanOrEqual(Date.UTC(year, 0, 1) / 1000);
      }
    }
  });

  test("default year seeds BLUEBERRY consensus; unknown year throws", () => {
    expect(DEFAULT_CHECKPOINT_YEAR).toBe(2019);
    expect(CHECKPOINT_HEIGHT).toBe(556_416);
    expect(BLUEBERRY_HEADER_CONSENSUS.checkpoint.height).toBe(556_416);
    expect(() => checkpointForYear(1999)).toThrow(/unknown checkpoint year/i);

    const seed = checkpointSeedRecord();
    const chain = validateHeaderChain(
      [seed],
      BLUEBERRY_HEADER_CONSENSUS,
      seed.header.timestamp + 60,
    );
    expect(chain.tipHeight).toBe(556_416);
  });

  test("non-default year builds a valid one-header chain", () => {
    for (const year of [2009, 2015]) {
      const seed = checkpointSeedRecord(year);
      const chain = validateHeaderChain(
        [seed],
        consensusForYear(year),
        seed.header.timestamp + 60,
      );
      expect(chain.tipHeight).toBe(checkpointForYear(year).height);
    }
  });
});
