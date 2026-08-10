# blueberry UTXO names design

Date: 2026-08-08  
Status: approved

## Goal

On the send UTXO selection screen, the user can rename the focused UTXO with **R**. Names persist in a dedicated SQLite table keyed by `txid:vout`. When a name exists, the list shows it in the column after the value graph. Help text documents Esc, R, Space, and Enter.

## Decisions

| Topic | Choice |
|-------|--------|
| Storage | Dedicated `utxo_names` table (not `key_value`) |
| Lookup key | `outpoint` text `txid:vout` (same as `WalletUtxoRow.key`) |
| Empty submit | Trim; empty → delete row (clear name) |
| Rename field | Prefill with current name (empty if none) |
| Spent UTXOs | Keep name rows forever; no cleanup |
| Snapshot | Load names in `snapshotFromDb` onto `WalletUtxoRow.name` |
| Esc while renaming | Cancel rename only; do not close the send modal |
| Name length | No hard max; store trimmed string as given |

## Data model

```sql
CREATE TABLE IF NOT EXISTS utxo_names (
  outpoint TEXT PRIMARY KEY,  -- `txid:vout`
  name TEXT NOT NULL
);
```

Repository API (same style as other repos):

- `get(outpoint): string | null`
- `upsert(outpoint, name)` — insert or replace
- `delete(outpoint)` — clear name
- `list(): { outpoint, name }[]` — used when building the wallet snapshot

Wire `utxoNames` onto `Database` and implement it in `sqlite-database.ts` / `schema.ts`.

## UI and keys

On the UTXO selection step only (`SendBody` when `step === "utxos"`):

**Help text** (always visible, dim):

`Esc to close · R to rename · Space to select · Enter to continue`

**Row layout** (name only when present; next column after value bar):

`[x] <amount>  <outpoint>  <age>  <valueBar>  <name?>`

**Rename flow:**

1. Focus a row → press `R` / `r`.
2. Show a text `input` prefilled with the current name (or empty).
3. While renaming, pause list keys (no Space / ↑↓ / Enter-to-continue).
4. Enter: trim → upsert, or delete if empty → exit rename → refresh shown name.
5. Esc: cancel rename; no write. Esc does not close the send modal while renaming.
6. No UTXOs: **R** does nothing (same as Space today).

## Data flow

1. **`WalletUtxoRow`** gains `name: string | null`.
2. **`snapshotFromDb`** loads `db.utxoNames.list()` into a map, then sets each row’s `name` from outpoint.
3. **Rename save** (from UTXO step):
   - Write through a small active-context helper (same idea as `send-context`): upsert trimmed name, or delete if empty.
   - Rebuild the wallet snapshot from DB and `apply` it so the list shows the new name at once.
4. **Rename cancel**: no DB write; leave the snapshot unchanged.
5. **Send build / broadcast**: ignore names; names are display-only.

## Errors / edge cases

- No UTXOs: **R** is a no-op.
- Esc while renaming: exit rename only; keep the send modal open.
- Esc when not renaming: keep current modal close behavior.
- Whitespace-only name: treated as empty → delete.

## Tests

- Schema/repo: upsert, get, delete, list; empty/whitespace delete path via helper.
- `snapshotFromDb`: named outpoint appears on the matching row; missing name → `null`.
- Rename helper: trim + upsert; empty → delete; snapshot refresh includes the change.

## Out of scope

- Names on other screens (balance, tx list, preview).
- Auto-delete of spent UTXO names.
- Search/filter by name.
