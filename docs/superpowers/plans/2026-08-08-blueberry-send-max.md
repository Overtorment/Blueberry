# Send MAX Amount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept `MAX` in the send Amount field and build a no-change transaction that sends all selected UTXOs to the destination (`output = Σ − fee`).

**Architecture:** Carry `amountSats: bigint | 'max'` from the details form through build. Normal sends keep today’s `selectUTXO` + wallet change path. Max uses scure consolidation: `selectUTXO(inputs, [], 'all', { changeAddress: toAddress })`. Preview reports `changeSats = 0`.

**Tech Stack:** Bun, TypeScript, `@scure/btc-signer` (`selectUTXO`), existing TUI send flow (`WalletModal`, `send-context`).

## Global Constraints

- Match: trim, then case-insensitive exact `"max"` only
- Semantics: single output; recipient gets `Σ selected − fee`; no wallet change output
- Fee rate still chosen after amount; resolve max only at build time
- Spec: `docs/superpowers/specs/2026-08-08-blueberry-send-max-design.md`

---

## File map

| File | Role |
|------|------|
| `src/parse/format.ts` | `isSendMaxAmount()` helper |
| `tests/parse-balance.test.ts` | Tests for max token matching |
| `src/wallet/build-send-tx.ts` | Consolidation path when `amountSats === 'max'` |
| `tests/build-send-tx.test.ts` | Send-max builder tests |
| `src/tui/send-context.ts` | Skip unused-change lookup for max |
| `src/tui/components/WalletModal.tsx` | Accept MAX in Amount; pass `'max'` through |

---

### Task 1: `isSendMaxAmount` helper

**Files:**
- Modify: `src/parse/format.ts`
- Modify: `tests/parse-balance.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `export function isSendMaxAmount(input: string): boolean`

- [ ] **Step 1: Write the failing test**

Add to `tests/parse-balance.test.ts` (same describe block as `parseBtcToSats`, or a sibling):

```ts
import { isSendMaxAmount, parseBtcToSats } from "../src/parse/format.ts";

test("isSendMaxAmount accepts trimmed case-insensitive max only", () => {
  expect(isSendMaxAmount("max")).toBe(true);
  expect(isSendMaxAmount("MAX")).toBe(true);
  expect(isSendMaxAmount("Max")).toBe(true);
  expect(isSendMaxAmount(" Max ")).toBe(true);
  expect(isSendMaxAmount("maximum")).toBe(false);
  expect(isSendMaxAmount("maxx")).toBe(false);
  expect(isSendMaxAmount("")).toBe(false);
  expect(isSendMaxAmount("1")).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/parse-balance.test.ts`
Expected: FAIL — `isSendMaxAmount` is not exported / not defined

- [ ] **Step 3: Implement helper**

In `src/parse/format.ts`, next to `parseBtcToSats`:

```ts
/** True for the send-max token: trim, then case-insensitive exact "max". */
export function isSendMaxAmount(input: string): boolean {
  return input.trim().toLowerCase() === "max";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/parse-balance.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/parse/format.ts tests/parse-balance.test.ts
git commit -m "$(cat <<'EOF'
Add isSendMaxAmount helper for send Amount field.

EOF
)"
```

---

### Task 2: Builder send-max path

**Files:**
- Modify: `src/wallet/build-send-tx.ts`
- Modify: `tests/build-send-tx.test.ts`

**Interfaces:**
- Consumes: `isSendMaxAmount` not required here (builder takes typed `'max'`)
- Produces:
  - `BuildSendTxParams.amountSats: bigint | 'max'`
  - When `'max'`: consolidation select; `changeSats` always `0n` on result
  - `changeAddress` ignored for selection when max (callers may pass `toAddress`)

- [ ] **Step 1: Write the failing tests**

Add to `tests/build-send-tx.test.ts` inside `describe("buildSignedSendTx")`:

```ts
test("send-max spends all selected utxos to destination with no change", () => {
  const wallet = abandonWallet();
  const utxo = utxoAt(wallet);
  const feeRate = 10;
  const result = buildSignedSendTx({
    secret: MNEMONIC,
    wallet,
    utxos: [utxo],
    toAddress: BLUE_EXTERNAL_1,
    amountSats: "max",
    feeRateSatPerVb: feeRate,
    changeAddress: BLUE_INTERNAL_0,
  });

  expect(result.changeSats).toBe(0n);
  expect(result.feeSats).toBe(BigInt(Math.ceil(feeRate * result.vsize)));

  const tx = Transaction.fromRaw(hex.decode(result.txHex));
  expect(tx.inputsLength).toBe(1);
  expect(tx.outputsLength).toBe(1);
  expect(tx.getOutputAddress(0)).toBe(BLUE_EXTERNAL_1);
  expect(tx.getOutput(0).amount).toBe(utxo.valueSats - result.feeSats);
});

test("send-max with multiple utxos uses all inputs and one output", () => {
  const wallet = abandonWallet();
  const a = utxoAt(wallet, 0);
  const b = {
    ...utxoAt(wallet, 1),
    txid: "22".repeat(32),
    valueSats: 80_000n,
  };
  const result = buildSignedSendTx({
    secret: MNEMONIC,
    wallet,
    utxos: [a, b],
    toAddress: BLUE_EXTERNAL_1,
    amountSats: "max",
    feeRateSatPerVb: 1,
    changeAddress: BLUE_INTERNAL_0,
  });

  const tx = Transaction.fromRaw(hex.decode(result.txHex));
  expect(tx.inputsLength).toBe(2);
  expect(tx.outputsLength).toBe(1);
  expect(result.changeSats).toBe(0n);
  expect(tx.getOutput(0).amount).toBe(a.valueSats + b.valueSats - result.feeSats);
});
```

Also extend the rejection test so `amountSats: 0n` still throws, and add that `'max'` does **not** throw for amount validation (covered by tests above).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/build-send-tx.test.ts`
Expected: FAIL — type/assignability or runtime treating `"max"` as invalid amount

- [ ] **Step 3: Implement builder path**

In `src/wallet/build-send-tx.ts`:

1. Change `BuildSendTxParams.amountSats` to `bigint | 'max'`.

2. In `buildDraftTx`, replace the amount check and `selectUTXO` block:

```ts
const sendMax = params.amountSats === "max";
if (!sendMax && params.amountSats <= 0n) {
  throw new Error("amount must be positive");
}
if (!(params.feeRateSatPerVb > 0)) throw new Error("fee rate must be positive");

// ... account / inputs setup unchanged ...

const feePerByte = BigInt(Math.ceil(params.feeRateSatPerVb));
let selected;
try {
  selected = sendMax
    ? selectUTXO(inputs, [], "all", {
        changeAddress: params.toAddress,
        feePerByte,
        createTx: true,
      })
    : selectUTXO(
        inputs,
        [{ address: params.toAddress, amount: params.amountSats }],
        "all",
        {
          changeAddress: params.changeAddress,
          feePerByte,
          createTx: true,
        },
      );
} catch {
  throw new Error("insufficient funds for amount and fee");
}
if (!selected?.tx || selected.fee === undefined) {
  throw new Error("insufficient funds for amount and fee");
}
const vsize = Math.ceil(selected.weight / 4);
const feeAdjustAddress = sendMax ? params.toAddress : params.changeAddress;
const feeSats = applyFractionalFee(
  selected.tx,
  feeAdjustAddress,
  selected.fee,
  params.feeRateSatPerVb,
  vsize,
);
let inputSum = 0n;
for (const u of params.utxos) inputSum += u.valueSats;
if (!sendMax && inputSum < params.amountSats + feeSats) {
  throw new Error("insufficient funds for amount and fee");
}
if (sendMax && inputSum <= feeSats) {
  throw new Error("insufficient funds for amount and fee");
}
```

3. In `buildSignedSendTx` and `buildUnsignedSendPsbt`, set:

```ts
changeSats:
  params.amountSats === "max"
    ? 0n
    : changeSatsFromTx(tx, params.changeAddress),
```

(For signed path use finalized `tx`; for PSBT path same as today with draft `tx`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/build-send-tx.test.ts`
Expected: PASS (including existing fractional-fee / change tests)

- [ ] **Step 5: Commit**

```bash
git add src/wallet/build-send-tx.ts tests/build-send-tx.test.ts
git commit -m "$(cat <<'EOF'
Support amountSats 'max' as no-change consolidation send.

EOF
)"
```

---

### Task 3: Wire send context + Amount field

**Files:**
- Modify: `src/tui/send-context.ts`
- Modify: `src/tui/components/WalletModal.tsx`

**Interfaces:**
- Consumes: `isSendMaxAmount` from `src/parse/format.ts`; `amountSats: bigint | 'max'` on builder
- Produces:
  - `SendBuildParams.amountSats: bigint | 'max'`
  - `SendDetails.amountSats: bigint | 'max'`
  - Max path does not call `firstUnusedInternalAddress`

- [ ] **Step 1: Update `send-context.ts`**

Change `SendBuildParams.amountSats` to `bigint | 'max'`.

In `buildActiveSendTx`:

```ts
export function buildActiveSendTx(params: SendBuildParams): BuildSendResult {
  if (!active) throw new Error("send context not initialized");
  const { db, wallet } = active;
  wallet.syncFromDb();
  const watch = wallet.snapshot();

  let changeAddress: string;
  if (params.amountSats === "max") {
    changeAddress = params.toAddress;
  } else {
    const used = usedWatchIndexes(
      db.transactions.list().map((t) => ({ tx: t.tx })),
      watch,
    );
    const change = firstUnusedInternalAddress(watch, used.internal);
    if (!change) throw new Error("no unused change address in watch window");
    changeAddress = change.address;
  }

  return buildSend({
    secret: loadWalletSecret(db),
    wallet: watch,
    utxos: params.utxos,
    toAddress: params.toAddress,
    amountSats: params.amountSats,
    feeRateSatPerVb: params.feeRateSatPerVb,
    changeAddress,
  });
}
```

- [ ] **Step 2: Update `WalletModal.tsx` Amount handling**

1. Import `isSendMaxAmount` alongside `parseBtcToSats`.

2. Change `SendDetails`:

```ts
type SendDetails = {
  toAddress: string;
  amountSats: bigint | "max";
};
```

3. In `SendDetailsForm` Enter handler, replace amount parse block with:

```ts
setAddressInvalid(false);
if (isSendMaxAmount(amount)) {
  setAmountInvalid(false);
  props.onContinue({ toAddress: address.trim(), amountSats: "max" });
  return;
}
const sats = parseBtcToSats(amount);
if (sats === null || sats <= 0n || sats > props.selectedSumSats) {
  setAmountInvalid(true);
  setField("amount");
  return;
}
setAmountInvalid(false);
props.onContinue({ toAddress: address.trim(), amountSats: sats });
```

`onFeerateContinue` already passes `details.amountSats` through — no logic change once the type widens.

- [ ] **Step 3: Typecheck / related tests**

Run: `bun test tests/build-send-tx.test.ts tests/parse-balance.test.ts`
Expected: PASS

Run: `bunx tsc --noEmit` (if the repo uses it) or rely on `bun test` + existing CI. Fix any `amountSats: bigint` assignability errors.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Send flow: select UTXO(s) → address → Amount `MAX` → fee rate → preview shows one recipient amount, no change line, fee sane.

- [ ] **Step 5: Commit**

```bash
git add src/tui/send-context.ts src/tui/components/WalletModal.tsx
git commit -m "$(cat <<'EOF'
Wire MAX amount through send UI and context.

EOF
)"
```

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Case-insensitive exact `max` after trim | Task 1 |
| `amountSats: bigint \| 'max'` | Tasks 2–3 |
| Consolidation `selectUTXO([], 'all', changeAddress: to)` | Task 2 |
| No wallet change for max | Tasks 2–3 |
| `changeSats = 0` | Task 2 |
| Fractional fee via single output | Task 2 (`applyFractionalFee` on `toAddress`) |
| Insufficient funds errors | Task 2 |
| Form accepts MAX; skips sum check | Task 3 |
| Builder tests 1+ UTXOs | Task 2 |
