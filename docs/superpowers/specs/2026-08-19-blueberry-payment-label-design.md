# blueberry payment label design

Date: 2026-08-19  
Status: approved

## Goal

On the send details step, the user must enter a payment label. We store that label by the constructed txid when we build the signed tx or PSBT. After the tx confirms and we parse the block, the tx list shows the label. The change UTXO (if any) gets the name `change from: {label}`.

## Decisions

| Topic | Choice |
|-------|--------|
| Tx list | Show the payment label on the matching tx row |
| Change UTXO name | `change from: {label}` via existing `utxo_names` |
| Who must enter a label | All send kinds: mnemonic, WIF, zpub, address |
| When we persist | On successful build (not on broadcast success) |
| Send-max | Store the tx label. Do not name a UTXO |
| Edit tx label | No UI. May add later |
| Edit UTXO name | Unchanged. **R** still works |
| First apply | Change outpoint is new. Write the name |
| Rematch | If that outpoint already has a name, do not overwrite |
| Unused pending rows | Keep forever. No cleanup |
| Label length | No hard max. Store the trimmed string |
| Empty label | Reject on the details step |

## Data model

```sql
CREATE TABLE IF NOT EXISTS tx_payment_labels (
  txid TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  change_vouts TEXT NOT NULL
);
```

`change_vouts` is a comma-separated list of output indexes with no spaces. Empty string means no change (send-max). Examples: `""`, `"1"`, `"0,2"`.

Repository API (same style as `utxoNames`):

- `upsert({ txid, label, changeVouts })` — insert or replace
- `get(txid): { txid, label, changeVouts } | null`
- `list(): { txid, label, changeVouts }[]` — used when building the wallet snapshot

Wire `txPaymentLabels` onto `Database` and implement it in `sqlite-database.ts` / `schema.ts`.

`WalletTxRow` gains `paymentLabel: string | null`.

`BuildSendResult` gains `txid: string` so the send UI can persist without a second decode.

## How we pick change vouts

Use the same change address the send builder already chose.

- Send-max: no change vouts.
- Else: each output whose address equals the change address.
- Self-send (dest === change): skip the output whose amount equals the payment amount. The leftover output(s) are change.

## UI and keys

On the send details step (`SendDetailsForm`):

Field order: Address → Amount → Payment label.

↑/↓ moves between those three fields.

Enter validates in this order:

1. Address must be valid.
2. Amount must be max or a positive sat value that does not exceed the selected sum.
3. Payment label must be non-empty after trim.

Invalid field: mark it and move focus there. Do not continue.

The preview help line includes the payment label.

Tx list row when a label exists:

`<time>  <shortTxid>  <netDelta>  <paymentLabel>`

When no label exists, keep the current row (no extra column).

UTXO rename on the UTXO step stays as it is.

## Data flow

1. User completes details (address, amount, payment label) and fee rate.
2. `buildActiveSendTx` returns a signed tx or PSBT plus `txid` and `changeSats`.
3. A small helper (same style as `utxo-names-actions`) upserts `tx_payment_labels`:
   - `label` = trimmed payment label
   - `txid` = constructed txid
   - `change_vouts` = computed indexes, or `""` for send-max
4. Broadcast and PSBT export do not write this row again.
5. A later fee-rate rebuild creates a new txid and a new row. Old unused rows stay.
6. `parse-blocks` upserts the confirmed watch tx. Then:
   - if no `tx_payment_labels` row for that txid, do nothing extra
   - if `change_vouts` is empty, do not write a UTXO name
   - else for each vout, write `utxo_names` as `change from: {label}` only when that outpoint has no name
7. `snapshotFromDb` loads `tx_payment_labels.list()` onto `WalletTxRow.paymentLabel` by txid.

Keep the `tx_payment_labels` row after apply. The tx list reads it.

## Errors / edge cases

- Failed build: do not write a label row.
- Whitespace-only label: reject on details. Do not reach build.
- User never broadcasts: the pending row stays. The tx list never shows it unless that txid is parsed.
- Address-only legacy PSBT: signing can change the txid. Then the stored row will not match the confirmed tx. BIP84 mnemonic and zpub keep the same txid.
- No UI to edit or clear the tx payment label.

## Tests

- Schema/repo: upsert, get, list; replace by same txid.
- Persist helper: successful build writes trimmed label and change vouts; send-max writes empty `change_vouts`.
- Parse apply: pending row with change vouts writes `change from: {label}`; send-max writes no UTXO name; a second apply does not overwrite an existing UTXO name.
- `snapshotFromDb`: stored label appears on the matching tx row; missing label → `null`.

## Out of scope

- UI to edit the tx payment label.
- Search or filter by payment label.
- Cleanup of unused pending rows.
- Showing unconfirmed txs in the tx list.
