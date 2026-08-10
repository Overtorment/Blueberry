# blueberry send MAX amount design

Date: 2026-08-08  
Status: approved

## Goal

In the send Amount field, `MAX` / `max` (case-insensitive exact token after trim) means: spend **all selected UTXOs** to the target address with **no change output**. Recipient gets `Σ inputs − fee` (classic send-max).

## Decisions

| Topic | Choice |
|-------|--------|
| Semantics | `output = Σ selected − fee`; single output; no wallet change |
| Match rule | Trim, then case-insensitive exact `"max"` (`max`, `MAX`, `Max`). Reject `"maximum"` etc. |
| When resolved | Fee rate is chosen after amount → carry a send-max flag until build |
| Builder path | scure consolidation: `selectUTXO(inputs, [], 'all', { changeAddress: toAddress, … })` |
| Change address | Not allocated for max; destination is scure’s sole payout address |
| Fractional fee | Existing `applyFractionalFee` may bump the single output → fee `ceil(rate × vsize)` |
| Preview | `changeSats = 0`; fee line already omits change when zero |
| UI chrome | Accept string in Amount; no extra MAX button/hint required |

## Data flow

1. **Details form:** valid address + amount. Carry `amountSats: bigint | 'max'` on send details / build params. If amount is send-max → `'max'`; else parse BTC → sats with `> 0` and `≤` selected sum.
2. **Fee rate step:** unchanged.
3. **Build (`buildActiveSendTx` / `buildDraftTx`):**
   - Normal (`bigint`): existing path with wallet change address.
   - Max (`'max'`): consolidation path above; do not require unused internal change.
4. **Result:** one output to destination; `changeSats = 0`; fee from rate × vsize rules.

## Errors

- Empty UTXOs / non-positive fee rate: same as today.
- Inputs cannot cover fee (or scure selection fails): `"insufficient funds for amount and fee"`.

## Tests

- **build-send-tx:** max with 1+ UTXOs → 1 output to destination, `changeSats === 0`, fee matches `ceil(rate × vsize)`, output = `Σ − fee`.
- **Form / parse:** `"max"` / `"MAX"` / `" Max "` accepted; non-exact tokens still invalid as amounts.
- **buildActiveSendTx:** max path does not depend on unused internal change.

## Out of scope

- Dedicated MAX button or placeholder copy (optional later).
- Auto-selecting UTXOs; user still selects inputs first.
