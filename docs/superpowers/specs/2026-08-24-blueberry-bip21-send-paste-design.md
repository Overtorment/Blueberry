# blueberry BIP21 send paste design

Date: 2026-08-24  
Status: approved

## Goal

When the user pastes a BIP21 `bitcoin:` URI into the send Address field, we parse it and fill Address, Amount, and Payment label.

## Decisions

| Topic | Choice |
|-------|--------|
| Where parse lives | `parseBip21()` in `src/parse/bip21.ts`. No new package |
| When we parse | Address `onInput` in `SendDetailsForm` |
| Scheme | `bitcoin:` case-insensitive. Optional `//` after the colon |
| Payment label source | `label` if present and non-empty after trim. Else `message` |
| Missing URI fields | Do not clear fields the user already typed |
| Present URI fields | Overwrite the current Amount / Payment label |
| Bad amount | Still return address and label. Keep the amount text. Mark Amount invalid now |
| Bad address in a URI | Still split. Mark Address invalid now |
| Unknown `req-*` | Whole parse fails (`null`). Address keeps the raw paste |
| Extra optional params | Ignore (`lightning` and others) |
| Lightning-only URI | `null` (no on-chain address) |
| Bad encoding on one query value | Drop that one param. Still parse the rest |
| Focus after parse | Stay on Address. ↑/↓ unchanged |
| Enter after fill | Same validation as today |
| Component tests | None. Parser unit tests only |

## API

```ts
export type Bip21Payment = {
  address: string;
  amount: string | null;
  label: string | null;
};

export function parseBip21(input: string): Bip21Payment | null;
```

`null` means: not a usable BIP21 URI. The form keeps the typed Address value.

`amount` is the raw BTC decimal string from the URI, or `null` if that param is absent or dropped. The parser does not convert to sats.

`label` is the decoded payment-label text, or `null` if both `label` and `message` are absent or empty after trim.

## Parse rules

1. Trim the input.
2. If it does not start with `bitcoin:` (case-insensitive), return `null`.
3. Strip the scheme. Then strip one optional `//`.
4. Split the rest on the first `?`. Left side is the address. Right side is the query (may be empty).
5. Percent-decode the address. If decode throws, keep the raw address text.
6. Trim the address. If it is empty, return `null`.
7. Split the query on `&`. Each piece is `name=value` (value may be empty). Param names are case-insensitive. Do not use `URLSearchParams` (`+` must stay `+`).
8. Percent-decode each name and value with `decodeURIComponent`. If a pair throws, drop that pair only.
9. If any param name starts with `req-` (case-insensitive) and the name after that prefix is not `amount`, `label`, or `message`, return `null`.
10. Read `amount`, `label`, and `message` (also accept `req-amount`, `req-label`, `req-message`). Use the first value for each name.
11. Trim `label` and `message`. Empty after trim means absent.
12. Set `label` to `label` if present, else `message`, else `null`.
13. Set `amount` to the raw amount string if the param exists, else `null`. Do not reject a bad amount here.
14. Return `{ address, amount, label }`.

Do not call `isAddressValid` or `parseBtcToSats` inside `parseBip21`. The form does that.

## Form data flow

In `SendDetailsForm` Address `onInput`:

1. Call `parseBip21(value)`.
2. If `null`: `setAddress(value)`. Clear the Address invalid mark if it was set. Stop.
3. If parsed:
   - `setAddress(parsed.address)`
   - If `parsed.amount !== null`: `setAmount(parsed.amount)`
   - If `parsed.label !== null`: `setPaymentLabel(parsed.label)` and clear the label invalid mark
   - Mark Address invalid when `!isAddressValid(parsed.address)`
   - Mark Amount invalid when `parsed.amount !== null` and `parseBtcToSats(parsed.amount)` is `null`
   - Clear Address invalid when the parsed address is valid
   - Clear Amount invalid when the parsed amount is present and parses
4. Focus stays on Address.

Enter still checks: valid address, then amount (`max` or positive sats ≤ selected sum), then a non-empty payment label.

## Errors

| Input | Result |
|-------|--------|
| Plain address or other text | `null`. Address keeps the paste |
| `bitcoin:` with no address | `null`. Address keeps the paste |
| Unknown `req-*` | `null`. Address keeps the paste |
| `bitcoin:?lightning=...` (no address) | `null`. Address keeps the paste |
| Valid URI, extra optional params | Parse. Ignore extras |
| Valid URI, bad amount text | Parse. Keep amount text. Mark Amount invalid |
| Valid URI, invalid address | Parse. Mark Address invalid |
| Bad percent-encoding on one query value | Drop that param. Parse the rest |

## Tests

File: `tests/unit/parse-bip21.test.ts`

Cover:

- Address only: `bitcoin:bc1...` → address set, amount and label `null`
- Amount: `?amount=0.01` → amount `"0.01"`
- Label: `?label=rent` → label `"rent"`
- Message fallback: `?message=lunch` and no label → label `"lunch"`
- Label wins over message when both exist
- Percent-encoding on label/message (`%20`, `%26`)
- Scheme case: `BITCOIN:`
- Optional `//`: `bitcoin://bc1...`
- Unknown `req-foo` → `null`
- Known `req-amount` still parses
- Lightning-only (empty address, `lightning=` present) → `null`
- Not a URI → `null`
- Bad amount still returns address and label
- Empty `label` falls back to `message`
- Leading/trailing whitespace around the whole URI

## Out of scope

- QR scan
- Lightning pay
- A separate message field
- Create BIP21 URIs on Receive
- OpenTUI component tests for `SendDetailsForm`
