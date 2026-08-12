# Peer services as signed INTEGER

## Goal

Store Bitcoin `nServices` bit patterns exactly in SQLite. Remove TEXT → signed INTEGER casts that clamp values above `2^63-1`.

## Design

`peers.services` is SQLite `INTEGER`. Application code keeps `bigint`.

Open the database with Bun `{ safeIntegers: true }` so signed 64-bit values
do not pass through JavaScript `Number`. Coerce other INTEGER columns back to
`number` in repository mappers.

Convert only at the repository boundary:

- Write: unsigned 64-bit → signed two’s-complement `bigint` for SQLite
- Read: signed SQLite integer → unsigned 64-bit `bigint`

Service queries use native bitwise ops:

```sql
WHERE (services & ?) != 0
```

Bind the mask with the same signed conversion. Do not use `CAST`.

## Schema

```sql
services INTEGER NOT NULL DEFAULT 0
```

No runtime migration path. The app is pre-production; local DBs were updated by hand / one-off open before this code landed.

Do not change repository interfaces. Do not add boolean flag columns.

## Verification

- Unit test: bit 63 round-trip and `listAliveWithServices` / `listWithServices` with high-bit masks
- Existing peer unit tests stay green
- Do not read wallet secrets
