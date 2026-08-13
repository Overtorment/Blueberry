import {
  bytesToHex,
  decodeBlockHeader,
  decodeCompactTarget,
  headerWork,
  hexToBytes,
  type HeaderChainEntry,
  type HeaderConsensusParams,
  type HeaderRecord,
  type ValidatedHeaderChain,
} from "bitcoin-headers";
import type { StoredHeader } from "../db/types.ts";
import { internalHexToDisplayHex } from "./hash.ts";

/**
 * Rebuild an in-memory chain from DB rows that were validated at write time.
 * Does NOT re-check PoW, links, nBits, or MTP — that work must not be repeated.
 */
export function trustedChainFromStored(
  records: readonly StoredHeader[],
  params: HeaderConsensusParams,
): ValidatedHeaderChain {
  if (records.length === 0) {
    throw new Error("trusted chain is empty");
  }

  const headers: HeaderRecord[] = [];
  const byHeight = new Map<number, HeaderRecord>();
  const heightByHashInternal = new Map<string, number>();
  const entriesByHeight = new Map<number, HeaderChainEntry>();
  const cumulativeWorkByHeight = new Map<number, bigint>();

  let expectedHeight = records[0]!.height;
  for (const stored of records) {
    if (stored.height !== expectedHeight) {
      throw new Error(
        `trusted chain gap at height ${stored.height}, expected ${expectedHeight}`,
      );
    }
    expectedHeight++;

    const header = decodeBlockHeader(stored.header);
    const hashInternal = hexToBytes(stored.hashInternalHex);
    const target = decodeCompactTarget(header.bits, params.powLimit);
    const work = headerWork(target);
    const record: HeaderRecord = {
      height: stored.height,
      hashDisplay: internalHexToDisplayHex(stored.hashInternalHex),
      hashInternalHex: stored.hashInternalHex,
      headerHex: bytesToHex(stored.header),
    };
    const entry: HeaderChainEntry = {
      record,
      header: {
        ...header,
        previousBlockHash: header.previousBlockHash.slice(),
        merkleRoot: header.merkleRoot.slice(),
      },
      hashInternal,
      target,
      work,
      cumulativeWork: stored.cumulativeWork,
    };

    headers.push(record);
    byHeight.set(record.height, record);
    heightByHashInternal.set(record.hashInternalHex, record.height);
    entriesByHeight.set(record.height, entry);
    cumulativeWorkByHeight.set(record.height, stored.cumulativeWork);
  }

  const tip = records[records.length - 1]!;
  const tipRecord = headers[headers.length - 1]!;
  return {
    headers,
    tipHeight: tip.height,
    tipHashInternal: hexToBytes(tip.hashInternalHex),
    tipHashDisplay: tipRecord.hashDisplay,
    chainWork: tip.cumulativeWork,
    params,
    byHeight,
    heightByHashInternal,
    entriesByHeight,
    cumulativeWorkByHeight,
  };
}

/** Lookback large enough for mainnet retarget + MTP while applying a 2000-header batch. */
export const TRUSTED_CHAIN_WINDOW = 4_096;
