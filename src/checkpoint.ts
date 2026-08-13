import {
  bytesToHex,
  decodeBlockHeader,
  headerHashDisplay,
  headerHashInternal,
  hexToBytes,
  MAINNET_POW_LIMIT,
  meetsTarget,
  type HeaderConsensusParams,
  type HeaderRecord as LibHeaderRecord,
} from "bitcoin-headers";
import type { HeaderRecord as DbHeaderRecord } from "./db/types.ts";

export type YearCheckpoint = {
  name: string;
  height: number;
  headerHex: string;
  previousTimestamps: readonly number[];
};

export const DEFAULT_CHECKPOINT_YEAR = 2019;

export const CHECKPOINTS: Readonly<Record<number, YearCheckpoint>> = {
  2009: {
    name: "2009",
    height: 0,
    headerHex: "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c",
    previousTimestamps: [],
  },
  2010: {
    name: "2010",
    height: 32256,
    headerHex: "010000004b0360d834a330ec7833e30e1f523ee05a0793361e29a73421964f980000000027b64a020af294e903feed93768705336a20090612a043f47af462a2f5e5b564f8ee3a4b6ad8001dd3a43707",
    previousTimestamps: [1262146941,1262149581,1262149719,1262149814,1262150129,1262150214,1262150242,1262151952,1262152015,1262152739],
  },
  2011: {
    name: "2011",
    height: 98784,
    headerHex: "01000000f9e89064a1802f4dbbaf44da8aa7b4cb034d6b8e57f8b850b89202000000000093691ac65801307ba452ee9933fb2213411e59a6c06ad792c8f17b081872b7d11bf3104d4c86041be1d4fa20",
    previousTimestamps: [1292951578,1292951886,1292952012,1292952292,1292953056,1292954457,1292954488,1292955666,1292955876,1292956393],
  },
  2012: {
    name: "2012",
    height: 159264,
    headerHex: "0100000060ed9ed3d58aa5aaccb3b77615257e71de9f90ead0a8bc333807000000000000d16eda495b013ce7769d0df6e636be50dae8b3ccb7e4cb16a9494161efeeddd84dc0f84eba760e1ae798fa04",
    previousTimestamps: [1324917709,1324918312,1324918615,1324919261,1324920875,1324920916,1324922170,1324922938,1324923046,1324923455],
  },
  2013: {
    name: "2013",
    height: 213696,
    headerHex: "02000000313cfe9867a8e53d64fb44ae84daa7ec8fb949e6117c5117f500000000000000197faa71992a3269d08231e52f28e1a0f2de48382cd80ab51aaae73eb5e2bab13404db506ba1051a2638a639",
    previousTimestamps: [1356527025,1356527347,1356527616,1356527725,1356528787,1356528948,1356530312,1356530388,1356530629,1356530758],
  },
  2014: {
    name: "2014",
    height: 276192,
    headerHex: "02000000df7267d2369a2f9abd5de63d8aed2dbe0fae68ddc69dc58c0300000000000000f85a3d0d333d52cabb0ac136cd42300dbc884dc1bcf357f7d1f77775ca58da3e585bb5520ca3031989d51fd6",
    previousTimestamps: [1387610367,1387611436,1387611587,1387612043,1387612319,1387612652,1387613542,1387613631,1387613901,1387615098],
  },
  2015: {
    name: "2015",
    height: 336672,
    headerHex: "02000000f918d7fcee76b98d30515b12075fcd5cc3960b22ed3ab1100000000000000000a25033cf348ffc45aa05960fac22712b60ca286a74d0c41d00598a3971432ab294f4a254ca0d1b187c1e0b9e",
    previousTimestamps: [1419960415,1419961243,1419961551,1419962245,1419962706,1419962841,1419963880,1419963937,1419965044,1419965406],
  },
  2016: {
    name: "2016",
    height: 391104,
    headerHex: "04000000e7dc13c64214c802bb7ca90908361f491314dcd379f3600a00000000000000002e1206a929290db469ae8dbda48914740b56429b8eaba5731b73ad1928235843a206855691950a18f64ce4a8",
    previousTimestamps: [1451551496,1451552180,1451552444,1451553082,1451553164,1451553210,1451556466,1451556853,1451557139,1451557421],
  },
  2017: {
    name: "2017",
    height: 445536,
    headerHex: "00000020f0676e1c5770bba8886aabd88bfd3ec266ce6823cbcd1e02000000000000000018d4d74915ec2d3e8357aa8d3e500f865ea24a99d0d2ac378d49626e67b8c9b327f96358ff7503187a2254e3",
    previousTimestamps: [1482942275,1482943154,1482943353,1482943483,1482943827,1482943998,1482944226,1482944734,1482945128,1482946227],
  },
  2018: {
    name: "2018",
    height: 499968,
    headerHex: "00000020e37c80a7a8b850e3e89add09090b6b89b874496513ef89000000000000000000285ddc7985e7c34eb205d2c3129727f7bc10873e11e054b48d1a92786a42d7d2c8c8375a459600189b3aa792",
    previousTimestamps: [1513601500,1513602213,1513602371,1513603546,1513603617,1513603795,1513604312,1513604531,1513604702,1513604778],
  },
  2019: {
    name: "2019",
    height: 556416,
    headerHex: "00000020120b3264562d49df59c400a0f276448db2a9aa4bf6f4080000000000000000005cb4b52150fe7dec217b74db424e442ef8b24105c244ebaeb59f638db9c48ef3c94f2a5ca5183217b412a530",
    previousTimestamps: [1546272034,1546272941,1546273128,1546273329,1546273560,1546273750,1546273997,1546274625,1546275222,1546275302],
  },
  2020: {
    name: "2020",
    height: 608832,
    headerHex: "00004020e0f105d0936b0ac5fac1cb5d9f081d6d1b2fcf7ce00a08000000000000000000e88dc18e1a134c57687750236a894b66e4ed10a8042363b2af20cae91cbaa4259dbefb5dd0bc15175262f29b",
    previousTimestamps: [1576773941,1576774285,1576774326,1576774478,1576774719,1576776313,1576777608,1576777795,1576778789,1576779043],
  },
  2021: {
    name: "2021",
    height: 663264,
    headerHex: "00004020e9e291c42c194d21c757e758b8d41bdb063b5b7c7b040a0000000000000000008720b3535c551daf796c259892bbae42025d3ab06ee93035f7b9b1cbf3194b249020e95f17220f173f3501de",
    previousTimestamps: [1609108375,1609108889,1609108947,1609109006,1609110775,1609111007,1609112294,1609113086,1609113473,1609113673],
  },
  2022: {
    name: "2022",
    height: 715680,
    headerHex: "04004020a9a215507d9d1f3b65b53b7a193dc04de9c5d3210d68040000000000000000005cda18b68325b04226116b7dd2ea077c24d41a31ba54f33921f4397a9b258df357dec661ab980b170de268cc",
    previousTimestamps: [1640416724,1640417432,1640419806,1640419927,1640419962,1640420384,1640420722,1640420791,1640421216,1640422619],
  },
  2023: {
    name: "2023",
    height: 768096,
    headerHex: "0000602025f63077f95bfec0944643ba896f9733200f815a525201000000000000000000a1b58dc8c037f5840da2ac5666214694baea8249bf7c2ffc4492199e49752c13a480a06390f507178de119fa",
    previousTimestamps: [1671456993,1671458861,1671459061,1671460133,1671460670,1671461297,1671461779,1671462305,1671462418,1671462730],
  },
  2024: {
    name: "2024",
    height: 822528,
    headerHex: "00e0ff3f82f7aacf60fac3873b0beade61d0701639090ae5f47800000000000000000000acbc1b3381c671b2b7753bb2252d3ebd6900486ec8153ceb10e954a86e3f9e1468788665b3e80317f5171649",
    previousTimestamps: [1703307480,1703307623,1703308075,1703308219,1703308831,1703309131,1703310142,1703310473,1703311260,1703311291],
  },
  2025: {
    name: "2025",
    height: 876960,
    headerHex: "00e0ff3770d3358d24864b8137e600a0d4150157a83f47ab282400000000000000000000e6cc8c712991dbca8da94b4d238c7034a35d2e825478a9bf1d0ff1b0e7cdcd6659c571675c9002177e179038",
    previousTimestamps: [1735500166,1735501043,1735501179,1735502839,1735503847,1735504540,1735504699,1735505178,1735507365,1735508535],
  },
  2026: {
    name: "2026",
    height: 929376,
    headerHex: "00a08a260e49aad9579816db693237b56ca3782da55945259cd301000000000000000000bdc5efe5589ed9210f69e3a8ab04b270bb7667dc75d6e33dc5219516f40c7c88f6b34c6905e6011747a8e967",
    previousTimestamps: [1766630238,1766631836,1766632192,1766632896,1766633291,1766633053,1766633169,1766633663,1766633746,1766633953],
  },
};

export function checkpointForYear(year: number): YearCheckpoint {
  const entry = CHECKPOINTS[year];
  if (!entry) throw new Error(`unknown checkpoint year: ${year}`);
  return entry;
}

function consensusFrom(checkpoint: YearCheckpoint): HeaderConsensusParams {
  const headerBytes = hexToBytes(checkpoint.headerHex);
  return {
    powLimit: MAINNET_POW_LIMIT,
    targetSpacingSeconds: 10 * 60,
    targetTimespanSeconds: 14 * 24 * 60 * 60,
    retargetInterval: 2_016,
    medianTimeSpan: 11,
    maxFutureSeconds: 2 * 60 * 60,
    checkpoint: {
      height: checkpoint.height,
      headerBytes,
      hashDisplay: headerHashDisplay(decodeBlockHeader(headerBytes)),
      previousTimestamps: checkpoint.previousTimestamps,
    },
  };
}

export function consensusForYear(year: number): HeaderConsensusParams {
  return consensusFrom(checkpointForYear(year));
}

const DEFAULT = CHECKPOINTS[DEFAULT_CHECKPOINT_YEAR]!;

export const CHECKPOINT_HEIGHT = DEFAULT.height;
export const CHECKPOINT_HEADER_HEX = DEFAULT.headerHex;
export const CHECKPOINT_HEADER = hexToBytes(CHECKPOINT_HEADER_HEX);
export const CHECKPOINT_DISPLAY_HASH = headerHashDisplay(
  decodeBlockHeader(CHECKPOINT_HEADER),
);
export const PRE_CHECKPOINT_TIMESTAMPS = DEFAULT.previousTimestamps;

export const BLUEBERRY_HEADER_CONSENSUS: HeaderConsensusParams = consensusForYear(
  DEFAULT_CHECKPOINT_YEAR,
);

export function checkpointDbRecord(
  year: number = DEFAULT_CHECKPOINT_YEAR,
): DbHeaderRecord {
  const cp = checkpointForYear(year);
  const header = hexToBytes(cp.headerHex);
  return {
    height: cp.height,
    hashInternalHex: bytesToHex(headerHashInternal(decodeBlockHeader(header))),
    header: header.slice(),
  };
}

export function checkpointSeedRecord(year: number = DEFAULT_CHECKPOINT_YEAR): LibHeaderRecord & {
  header: ReturnType<typeof decodeBlockHeader>;
  hashInternal: Uint8Array;
} {
  const cp = checkpointForYear(year);
  const headerBytes = hexToBytes(cp.headerHex);
  const header = decodeBlockHeader(headerBytes);
  if (!meetsTarget(headerHashInternal(header), header.bits)) {
    throw new Error("checkpoint header fails PoW check");
  }
  const hashInternal = headerHashInternal(header);
  return {
    height: cp.height,
    hashDisplay: headerHashDisplay(header),
    hashInternalHex: bytesToHex(hashInternal),
    headerHex: cp.headerHex,
    header,
    hashInternal,
  };
}
