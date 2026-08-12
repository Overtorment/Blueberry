const U64 = 1n << 64n;
const I64_MAX = (1n << 63n) - 1n;

/** Unsigned Bitcoin nServices → signed SQLite INTEGER bit pattern. */
export function toSqliteServices(services: bigint): bigint {
  const v = services & (U64 - 1n);
  return v > I64_MAX ? v - U64 : v;
}

/** Signed SQLite INTEGER bit pattern → unsigned Bitcoin nServices. */
export function fromSqliteServices(
  stored: bigint | number | string,
): bigint {
  const v = typeof stored === "bigint" ? stored : BigInt(stored);
  return v < 0n ? v + U64 : v;
}
