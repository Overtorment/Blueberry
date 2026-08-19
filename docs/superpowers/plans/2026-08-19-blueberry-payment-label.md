# Payment Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a payment label on send, store it by constructed txid at build time, show it on the parsed tx row, and name the change UTXO `change from: {label}`.

**Architecture:** Add `tx_payment_labels` (txid, label, change_vouts). `buildSend` returns `txid` and `changeVouts`. A TUI helper writes the row after a successful build. `parse-blocks` applies change names into `utxo_names` on first parse. `snapshotFromDb` loads the label onto `WalletTxRow.paymentLabel`.

**Tech Stack:** Bun, TypeScript, bun:sqlite, `@scure/btc-signer`, existing TUI (`WalletModal`, `Transactions`, `wallet-txs-store`).

## Global Constraints

- Persist on successful build, not on broadcast success
- All send kinds require the label (mnemonic, WIF, zpub, address)
- Send-max: store the tx label; `change_vouts` is `""`; do not name a UTXO
- Change UTXO name: `change from: {label}`
- Rematch: do not overwrite an existing UTXO name
- Keep `tx_payment_labels` rows forever; no edit UI; no cleanup
- Empty/whitespace label: reject on the details step
- Spec: `docs/superpowers/specs/2026-08-19-blueberry-payment-label-design.md`

---

## File map

| File | Role |
|------|------|
| `src/db/schema.ts` | `CREATE TABLE tx_payment_labels` |
| `src/db/types.ts` | `TxPaymentLabel` + `TxPaymentLabelsRepository` + `Database.txPaymentLabels` |
| `src/db/sqlite-database.ts` | Repository implementation |
| `tests/unit/sqlite-tx-payment-labels.test.ts` | Repo upsert/get/list |
| `src/wallet/build-send-tx.ts` | `changeOutputVouts`; `txid` + `changeVouts` on `BuildSendResult` |
| `tests/unit/build-send-tx.test.ts` | Assert txid and change vouts |
| `src/tui/payment-label-actions.ts` | Persist helper + parse apply helper |
| `tests/unit/payment-label-actions.test.ts` | Persist trim/vouts; apply/skip/overwrite |
| `src/main.tsx` | `setActivePaymentLabelContext(db)` |
| `src/modules/parse-blocks.ts` | Call apply after each watch-tx upsert |
| `src/tui/wallet-txs-store.ts` | `WalletTxRow.paymentLabel`; load in `snapshotFromDb` |
| `tests/unit/tui-wallet-txs.test.ts` | Snapshot includes payment label |
| `tests/unit/wallet-txs-store-eta.test.ts` | Add `paymentLabel` on manual row |
| `src/tui/components/WalletModal.tsx` | Details field; persist on build; preview help |
| `src/tui/components/Transactions.tsx` | Show payment label on tx row |

---

### Task 1: `tx_payment_labels` schema and repository

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/types.ts`
- Modify: `src/db/sqlite-database.ts`
- Create: `tests/unit/sqlite-tx-payment-labels.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - Table `tx_payment_labels(txid TEXT PRIMARY KEY, label TEXT NOT NULL, change_vouts TEXT NOT NULL)`
  - `export type TxPaymentLabel = { txid: string; label: string; changeVouts: string }`
  - `export interface TxPaymentLabelsRepository { upsert(row: TxPaymentLabel): void; get(txid: string): TxPaymentLabel | null; list(): TxPaymentLabel[]; }`
  - `Database.txPaymentLabels: TxPaymentLabelsRepository`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sqlite-tx-payment-labels.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";

describe("tx_payment_labels", () => {
  test("get/upsert/list by txid; replace keeps one row", () => {
    const db = createSqliteDatabase(":memory:");
    const txid = "aa".repeat(32);

    expect(db.txPaymentLabels.get(txid)).toBeNull();
    expect(db.txPaymentLabels.list()).toEqual([]);

    db.txPaymentLabels.upsert({
      txid,
      label: "rent",
      changeVouts: "1",
    });
    expect(db.txPaymentLabels.get(txid)).toEqual({
      txid,
      label: "rent",
      changeVouts: "1",
    });
    expect(db.txPaymentLabels.list()).toEqual([
      { txid, label: "rent", changeVouts: "1" },
    ]);

    db.txPaymentLabels.upsert({
      txid,
      label: "rent paid",
      changeVouts: "",
    });
    expect(db.txPaymentLabels.get(txid)).toEqual({
      txid,
      label: "rent paid",
      changeVouts: "",
    });
    expect(db.txPaymentLabels.list()).toHaveLength(1);

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sqlite-tx-payment-labels.test.ts`

Expected: FAIL — `txPaymentLabels` missing on Database / not implemented

- [ ] **Step 3: Implement schema, types, repository**

In `src/db/schema.ts`, after the `utxo_names` table:

```sql
    CREATE TABLE IF NOT EXISTS tx_payment_labels (
      txid TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      change_vouts TEXT NOT NULL
    );
```

In `src/db/types.ts`, after `UtxoNamesRepository`:

```ts
export type TxPaymentLabel = {
  txid: string;
  label: string;
  changeVouts: string;
};

export interface TxPaymentLabelsRepository {
  upsert(row: TxPaymentLabel): void;
  get(txid: string): TxPaymentLabel | null;
  list(): TxPaymentLabel[];
}
```

Add `txPaymentLabels: TxPaymentLabelsRepository` to `Database` next to `utxoNames`.

In `src/db/sqlite-database.ts`:

- Import `TxPaymentLabel` and `TxPaymentLabelsRepository` from `./types.ts`.
- After the `utxoNames` repository, add:

```ts
  const upsertTxPaymentLabel = raw.query(
    `INSERT INTO tx_payment_labels(txid, label, change_vouts)
     VALUES (?, ?, ?)
     ON CONFLICT(txid) DO UPDATE SET
       label = excluded.label,
       change_vouts = excluded.change_vouts`,
  );
  const getTxPaymentLabel = raw.query(
    `SELECT txid, label, change_vouts FROM tx_payment_labels WHERE txid = ?`,
  );
  const listTxPaymentLabels = raw.query(
    `SELECT txid, label, change_vouts FROM tx_payment_labels ORDER BY txid`,
  );

  const txPaymentLabels: TxPaymentLabelsRepository = {
    upsert(row) {
      upsertTxPaymentLabel.run(row.txid, row.label, row.changeVouts);
    },
    get(txid) {
      const row = getTxPaymentLabel.get(txid) as {
        txid: string;
        label: string;
        change_vouts: string;
      } | null;
      if (!row) return null;
      return {
        txid: row.txid,
        label: row.label,
        changeVouts: row.change_vouts,
      };
    },
    list() {
      const rows = listTxPaymentLabels.all() as Array<{
        txid: string;
        label: string;
        change_vouts: string;
      }>;
      return rows.map((row) => ({
        txid: row.txid,
        label: row.label,
        changeVouts: row.change_vouts,
      }));
    },
  };
```

Return `txPaymentLabels` from `createSqliteDatabase` next to `utxoNames`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sqlite-tx-payment-labels.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/types.ts src/db/sqlite-database.ts tests/unit/sqlite-tx-payment-labels.test.ts
git commit -m "$(cat <<'EOF'
Add tx_payment_labels table and repository.

EOF
)"
```

---

### Task 2: Constructed txid and change vouts on send build

**Files:**
- Modify: `src/wallet/build-send-tx.ts`
- Modify: `tests/unit/build-send-tx.test.ts`

**Interfaces:**
- Consumes: `@scure/btc-signer` `Transaction`
- Produces:
  - `export function changeOutputVouts(tx: Transaction, changeAddress: string, toAddress: string, paymentAmount: bigint | "max"): number[]`
  - `BuildSendTxResult.txid: string`
  - `BuildSendTxResult.changeVouts: number[]`
  - `BuildSendPsbtResult.txid: string`
  - `BuildSendPsbtResult.changeVouts: number[]`
  - Send-max: `changeVouts` is `[]`
  - `txid` is scure `tx.id` (display hex). It must match bitcoinjs `Transaction.getId()` for the same bytes.

- [ ] **Step 1: Write the failing assertions**

In `tests/unit/build-send-tx.test.ts`, add this import next to the existing `buildSend` import:

```ts
import {
  buildSend,
  buildSignedSendTx,
  buildUnsignedSendPsbt,
  changeOutputVouts,
} from "../../src/wallet/build-send-tx.ts";
```

In the existing test `"signs p2wpkh with change near the requested fee rate"`, after the dest amount assert, add:

```ts
    expect(result.txid).toBe(tx.id);
    expect(result.changeVouts).toEqual(
      changeOutputVouts(tx, BLUE_INTERNAL_0, BLUE_EXTERNAL_1, amountSats),
    );
    expect(result.changeVouts).toHaveLength(1);
    expect(tx.getOutputAddress(result.changeVouts[0]!)).toBe(BLUE_INTERNAL_0);
```

In the existing test `"send-max: one output, no change, fee ceil(rate × vsize)"`, after the output asserts, add:

```ts
    expect(result.txid).toBe(tx.id);
    expect(result.changeVouts).toEqual([]);
```

Add a new test in the same `describe("buildSignedSendTx")` block:

```ts
  test("self-send change vout skips the payment output", () => {
    const wallet = abandonWallet();
    const amountSats = 10_000n;
    const result = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [utxoAt(wallet)],
      toAddress: BLUE_INTERNAL_0,
      amountSats,
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    });
    const tx = Transaction.fromRaw(hex.decode(result.txHex));
    expect(result.changeVouts).toEqual(
      changeOutputVouts(tx, BLUE_INTERNAL_0, BLUE_INTERNAL_0, amountSats),
    );
    expect(result.changeVouts).toHaveLength(1);
    expect(tx.getOutput(result.changeVouts[0]!).amount).not.toBe(amountSats);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/build-send-tx.test.ts`

Expected: FAIL — `txid` / `changeVouts` / `changeOutputVouts` missing

- [ ] **Step 3: Implement `changeOutputVouts` and attach fields**

In `src/wallet/build-send-tx.ts`, add `txid` and `changeVouts` to both result types:

```ts
export type BuildSendTxResult = {
  kind: "signed";
  txHex: string;
  txid: string;
  feeSats: bigint;
  vsize: number;
  changeSats: bigint;
  changeVouts: number[];
};

export type BuildSendPsbtResult = {
  kind: "psbt";
  psbtHex: string;
  txid: string;
  feeSats: bigint;
  vsize: number;
  changeSats: bigint;
  changeVouts: number[];
};
```

Export `changeOutputVouts` next to `changeSatsFromTx` (keep `addressesEqual` private):

```ts
export function changeOutputVouts(
  tx: Transaction,
  changeAddress: string,
  toAddress: string,
  paymentAmount: bigint | "max",
): number[] {
  if (paymentAmount === "max") return [];
  const vouts: number[] = [];
  for (let i = 0; i < tx.outputsLength; i++) {
    if (!addressesEqual(tx.getOutputAddress(i), changeAddress)) continue;
    const out = tx.getOutput(i);
    if (out.amount === undefined) continue;
    if (
      addressesEqual(toAddress, changeAddress) &&
      out.amount === paymentAmount
    ) {
      continue;
    }
    vouts.push(i);
  }
  return vouts;
}
```

Add a private helper used by both builders:

```ts
function sendIdAndChange(
  tx: Transaction,
  params: BuildSendTxParams,
): { txid: string; changeVouts: number[] } {
  if (!tx.id) throw new Error("missing txid");
  return {
    txid: tx.id,
    changeVouts: changeOutputVouts(
      tx,
      params.changeAddress,
      params.toAddress,
      params.amountSats,
    ),
  };
}
```

In `buildSignedSendTx`, spread `sendIdAndChange(tx, params)` into the returned object.

In `buildUnsignedSendPsbt`, spread `sendIdAndChange(tx, params)` into the returned object.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/build-send-tx.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/wallet/build-send-tx.ts tests/unit/build-send-tx.test.ts
git commit -m "$(cat <<'EOF'
Return constructed txid and change vouts from send build.

EOF
)"
```

---

### Task 3: Persist payment label after a successful build

**Files:**
- Create: `src/tui/payment-label-actions.ts`
- Create: `tests/unit/payment-label-actions.test.ts`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `Database.txPaymentLabels`, `BuildSendResult.txid`, `BuildSendResult.changeVouts`
- Produces:
  - `setActivePaymentLabelContext(db: Database): void`
  - `savePaymentLabel(params: { txid: string; label: string; changeVouts: number[] }): void` — trim label; empty throws `Error("payment label is required")`; upsert `changeVouts.join(",")`
  - `applyPaymentLabelOnParsedTx(db: Database, txid: string): void` — if no row, return; if `changeVouts === ""`, return; else for each vout write `utxo_names` as `change from: {label}` only when `utxoNames.get(outpoint)` is null. Do not delete the payment-label row.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/payment-label-actions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import {
  applyPaymentLabelOnParsedTx,
  savePaymentLabel,
  setActivePaymentLabelContext,
} from "../../src/tui/payment-label-actions.ts";
import { outpointKey } from "../../src/parse/extract.ts";
import {
  buildSignedSendTx,
  changeOutputVouts,
} from "../../src/wallet/build-send-tx.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const BLUE_EXTERNAL_1 = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g";
const BLUE_INTERNAL_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";

function abandonWallet() {
  return deriveWatchWallet(MNEMONIC, { external: 2, internal: 2 });
}

function utxoAt(wallet: ReturnType<typeof deriveWatchWallet>, index = 0) {
  const recv = wallet.addresses.find((a) => !a.change && a.index === index)!;
  return {
    txid: "11".repeat(32),
    vout: 0,
    valueSats: 100_000n,
    scriptPubKey: recv.scriptPubKey,
  };
}

describe("savePaymentLabel", () => {
  test("trims label and stores change vouts for a built tx", () => {
    const db = createSqliteDatabase(":memory:");
    setActivePaymentLabelContext(db);
    const wallet = abandonWallet();
    const amountSats = 50_000n;
    const built = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [utxoAt(wallet)],
      toAddress: BLUE_EXTERNAL_1,
      amountSats,
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    });
    const tx = Transaction.fromRaw(hex.decode(built.txHex));
    const vouts = changeOutputVouts(
      tx,
      BLUE_INTERNAL_0,
      BLUE_EXTERNAL_1,
      amountSats,
    );

    savePaymentLabel({
      txid: built.txid,
      label: "  groceries  ",
      changeVouts: built.changeVouts,
    });

    expect(db.txPaymentLabels.get(built.txid)).toEqual({
      txid: built.txid,
      label: "groceries",
      changeVouts: vouts.join(","),
    });
    db.close();
  });

  test("send-max stores empty change vouts", () => {
    const db = createSqliteDatabase(":memory:");
    setActivePaymentLabelContext(db);
    const wallet = abandonWallet();
    const built = buildSignedSendTx({
      secret: MNEMONIC,
      wallet,
      utxos: [utxoAt(wallet)],
      toAddress: BLUE_EXTERNAL_1,
      amountSats: "max",
      feeRateSatPerVb: 1,
      changeAddress: BLUE_INTERNAL_0,
    });

    savePaymentLabel({
      txid: built.txid,
      label: "empty wallet",
      changeVouts: built.changeVouts,
    });

    expect(db.txPaymentLabels.get(built.txid)?.changeVouts).toBe("");
    db.close();
  });

  test("rejects a blank label", () => {
    const db = createSqliteDatabase(":memory:");
    setActivePaymentLabelContext(db);
    expect(() =>
      savePaymentLabel({ txid: "aa".repeat(32), label: "   ", changeVouts: [] }),
    ).toThrow("payment label is required");
    db.close();
  });
});

describe("applyPaymentLabelOnParsedTx", () => {
  test("names change outpoints and keeps the tx label row", () => {
    const db = createSqliteDatabase(":memory:");
    const txid = "bb".repeat(32);
    db.txPaymentLabels.upsert({
      txid,
      label: "coffee",
      changeVouts: "1",
    });

    applyPaymentLabelOnParsedTx(db, txid);

    expect(db.utxoNames.get(outpointKey(txid, 1))).toBe("change from: coffee");
    expect(db.txPaymentLabels.get(txid)?.label).toBe("coffee");
    db.close();
  });

  test("send-max writes no UTXO name", () => {
    const db = createSqliteDatabase(":memory:");
    const txid = "cc".repeat(32);
    db.txPaymentLabels.upsert({
      txid,
      label: "all in",
      changeVouts: "",
    });

    applyPaymentLabelOnParsedTx(db, txid);

    expect(db.utxoNames.list()).toEqual([]);
    expect(db.txPaymentLabels.get(txid)?.label).toBe("all in");
    db.close();
  });

  test("does not overwrite an existing UTXO name", () => {
    const db = createSqliteDatabase(":memory:");
    const txid = "dd".repeat(32);
    const out = outpointKey(txid, 0);
    db.txPaymentLabels.upsert({
      txid,
      label: "new",
      changeVouts: "0",
    });
    db.utxoNames.upsert(out, "user rename");

    applyPaymentLabelOnParsedTx(db, txid);

    expect(db.utxoNames.get(out)).toBe("user rename");
    db.close();
  });

  test("no-op when no payment label row exists", () => {
    const db = createSqliteDatabase(":memory:");
    applyPaymentLabelOnParsedTx(db, "ee".repeat(32));
    expect(db.utxoNames.list()).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/payment-label-actions.test.ts`

Expected: FAIL — module / exports missing

- [ ] **Step 3: Implement helpers and wire main**

Create `src/tui/payment-label-actions.ts`:

```ts
import type { Database } from "../db/types.ts";
import { outpointKey } from "../parse/extract.ts";

export type SavePaymentLabelParams = {
  txid: string;
  label: string;
  changeVouts: number[];
};

let activeDb: Database | null = null;

export function setActivePaymentLabelContext(db: Database): void {
  activeDb = db;
}

export function savePaymentLabel(params: SavePaymentLabelParams): void {
  if (!activeDb) throw new Error("payment label context not initialized");
  const label = params.label.trim();
  if (!label) throw new Error("payment label is required");
  activeDb.txPaymentLabels.upsert({
    txid: params.txid,
    label,
    changeVouts: params.changeVouts.join(","),
  });
}

export function applyPaymentLabelOnParsedTx(db: Database, txid: string): void {
  const pending = db.txPaymentLabels.get(txid);
  if (!pending) return;
  if (pending.changeVouts === "") return;
  const name = `change from: ${pending.label}`;
  for (const part of pending.changeVouts.split(",")) {
    if (part === "") continue;
    const vout = Number(part);
    const out = outpointKey(txid, vout);
    if (db.utxoNames.get(out) === null) {
      db.utxoNames.upsert(out, name);
    }
  }
}
```

In `src/main.tsx`, import and call after `setActiveSendContext(db, wallet)`:

```ts
import { setActivePaymentLabelContext } from "./tui/payment-label-actions.ts";
```

```ts
  setActiveSendContext(db, wallet);
  setActivePaymentLabelContext(db);
  setActiveUtxoNamesContext(db, wallet, walletTxsStore);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/payment-label-actions.test.ts tests/unit/sqlite-tx-payment-labels.test.ts tests/unit/build-send-tx.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/payment-label-actions.ts tests/unit/payment-label-actions.test.ts src/main.tsx
git commit -m "$(cat <<'EOF'
Persist payment labels at send build and apply change names on parse.

EOF
)"
```

---

### Task 4: Apply change names from parse-blocks

**Files:**
- Modify: `src/modules/parse-blocks.ts`

**Interfaces:**
- Consumes: `applyPaymentLabelOnParsedTx(db: Database, txid: string): void`
- Produces: after each `transactions.upsert` of a watch tx, call `applyPaymentLabelOnParsedTx(ctx.db, tx.txid)`

- [ ] **Step 1: Call apply after each watch-tx upsert**

In `src/modules/parse-blocks.ts`, add:

```ts
import { applyPaymentLabelOnParsedTx } from "../tui/payment-label-actions.ts";
```

Change the watch-tx loop to:

```ts
        for (const tx of watchTxs) {
          ctx.db.transactions.upsert({
            txid: tx.txid,
            height: block.height,
            txIndex: tx.txIndex,
            blockHashInternalHex: block.blockHashInternalHex,
            tx: tx.tx,
            netDeltaSats: 0,
          });
          applyPaymentLabelOnParsedTx(ctx.db, tx.txid);
        }
```

Do not delete the payment-label row.

- [ ] **Step 2: Run related tests**

Run: `bun test tests/unit/parse-blocks.test.ts tests/unit/payment-label-actions.test.ts`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/modules/parse-blocks.ts
git commit -m "$(cat <<'EOF'
Apply payment-label change names when parse upserts a watch tx.

EOF
)"
```

---

### Task 5: Load payment labels into the tx snapshot

**Files:**
- Modify: `src/tui/wallet-txs-store.ts`
- Modify: `tests/unit/tui-wallet-txs.test.ts`
- Modify: `tests/unit/wallet-txs-store-eta.test.ts`

**Interfaces:**
- Consumes: `Database.txPaymentLabels.list()`
- Produces: `WalletTxRow.paymentLabel: string | null` set in `snapshotFromDb`

- [ ] **Step 1: Write the failing snapshot assertions**

In `tests/unit/tui-wallet-txs.test.ts`, in `"snapshotFromDb lists UTXOs newest-first when wallet is provided"`, after the two `transactions.upsert` calls and before `snapshotFromDb`, add:

```ts
    db.txPaymentLabels.upsert({
      txid: newer.getId(),
      label: "lunch",
      changeVouts: "0",
    });
```

Then after the existing UTXO name asserts, add:

```ts
    expect(snap.txs.find((t) => t.txid === newer.getId())?.paymentLabel).toBe(
      "lunch",
    );
    expect(snap.txs.find((t) => t.txid === older.getId())?.paymentLabel).toBeNull();
```

In `tests/unit/wallet-txs-store-eta.test.ts`, add `paymentLabel: null` to the manual tx row so the type still compiles after Step 3.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/tui-wallet-txs.test.ts`

Expected: FAIL — `paymentLabel` missing / undefined on tx rows

- [ ] **Step 3: Implement snapshot field**

In `src/tui/wallet-txs-store.ts`, add to `WalletTxRow`:

```ts
  /** User payment label from tx_payment_labels; null when unset. */
  paymentLabel: string | null;
```

In `snapshotFromDb`, before mapping `txs`:

```ts
  const labelByTxid = new Map(
    db.txPaymentLabels.list().map((r) => [r.txid, r.label]),
  );
```

When building each tx row, add:

```ts
        paymentLabel: labelByTxid.get(tx.txid) ?? null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/tui-wallet-txs.test.ts tests/unit/wallet-txs-store-eta.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/wallet-txs-store.ts tests/unit/tui-wallet-txs.test.ts tests/unit/wallet-txs-store-eta.test.ts
git commit -m "$(cat <<'EOF'
Load payment labels onto wallet tx snapshot rows.

EOF
)"
```

---

### Task 6: Send details field and persist on build

**Files:**
- Modify: `src/tui/components/WalletModal.tsx`

**Interfaces:**
- Consumes: `savePaymentLabel({ txid, label, changeVouts })`, `BuildSendResult.txid`, `BuildSendResult.changeVouts`
- Produces: required Payment label field on details; persist after successful `buildActiveSendTx`; preview help includes the label

- [ ] **Step 1: Extend `SendDetails` and `SendDetailsForm`**

Change `SendDetails` to:

```ts
type SendDetails = {
  toAddress: string;
  amountSats: bigint | "max";
  paymentLabel: string;
};
```

Replace `SendDetailsForm` with this implementation (keep the same props):

```tsx
function SendDetailsForm(props: {
  selectedSumSats: bigint;
  onContinue: (details: SendDetails) => void;
}) {
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentLabel, setPaymentLabel] = useState("");
  const [field, setField] = useState<"address" | "amount" | "label">("address");
  const [addressInvalid, setAddressInvalid] = useState(false);
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [labelInvalid, setLabelInvalid] = useState(false);

  useKeyboard((key) => {
    if (key.name === "up") {
      setField((f) =>
        f === "label" ? "amount" : f === "amount" ? "address" : "address",
      );
      return;
    }
    if (key.name === "down") {
      setField((f) =>
        f === "address" ? "amount" : f === "amount" ? "label" : "label",
      );
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      if (!isAddressValid(address)) {
        setAddressInvalid(true);
        setAmountInvalid(false);
        setLabelInvalid(false);
        setField("address");
        return;
      }
      setAddressInvalid(false);
      if (isSendMaxAmount(amount)) {
        if (paymentLabel.trim() === "") {
          setAmountInvalid(false);
          setLabelInvalid(true);
          setField("label");
          return;
        }
        setAmountInvalid(false);
        setLabelInvalid(false);
        props.onContinue({
          toAddress: address.trim(),
          amountSats: "max",
          paymentLabel: paymentLabel.trim(),
        });
        return;
      }
      const sats = parseBtcToSats(amount);
      if (sats === null || sats <= 0n || sats > props.selectedSumSats) {
        setAmountInvalid(true);
        setLabelInvalid(false);
        setField("amount");
        return;
      }
      setAmountInvalid(false);
      if (paymentLabel.trim() === "") {
        setLabelInvalid(true);
        setField("label");
        return;
      }
      setLabelInvalid(false);
      props.onContinue({
        toAddress: address.trim(),
        amountSats: sats,
        paymentLabel: paymentLabel.trim(),
      });
    }
  });

  const addressColor = addressInvalid ? THEME.error : undefined;
  const amountColor = amountInvalid ? THEME.error : undefined;
  const labelColor = labelInvalid ? THEME.error : undefined;

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      overflow="hidden"
    >
      <text fg={THEME.fgDim}>
        {"Selected "}
        <BtcAmount sats={props.selectedSumSats} />
        {" · ↑/↓ to switch · Esc to close"}
      </text>
      <text fg={addressInvalid ? THEME.error : THEME.fgDim}>Address</text>
      <input
        focused={field === "address"}
        value={address}
        placeholder="bc1…"
        textColor={addressColor}
        focusedTextColor={addressColor}
        onInput={(v) => {
          setAddress(v);
          if (addressInvalid) setAddressInvalid(false);
        }}
      />
      <text fg={amountInvalid ? THEME.error : THEME.fgDim}>Amount</text>
      <input
        focused={field === "amount"}
        value={amount}
        placeholder="0.00000000"
        textColor={amountColor}
        focusedTextColor={amountColor}
        onInput={(v) => {
          setAmount(v);
          if (amountInvalid) setAmountInvalid(false);
        }}
      />
      <text fg={labelInvalid ? THEME.error : THEME.fgDim}>Payment label</text>
      <input
        focused={field === "label"}
        value={paymentLabel}
        placeholder="groceries"
        textColor={labelColor}
        focusedTextColor={labelColor}
        onInput={(v) => {
          setPaymentLabel(v);
          if (labelInvalid) setLabelInvalid(false);
        }}
      />
    </box>
  );
}
```

- [ ] **Step 2: Show the label on the preview help line**

Extend `FeeHelpLine` props with `paymentLabel: string`. After the change amount block and before `{" · Esc to close"}`, add:

```tsx
      {` · ${props.paymentLabel}`}
```

Pass `paymentLabel={props.details.paymentLabel}` from `SendPreviewBody` into both `FeeHelpLine` uses (PSBT and signed). `SignedTxPreviewBody` must take `paymentLabel` and pass it through.

- [ ] **Step 3: Persist after a successful build**

Import:

```ts
import { savePaymentLabel } from "../payment-label-actions.ts";
```

In `onFeerateContinue`, after `buildActiveSendTx` succeeds and before `setPreview(result)`:

```ts
                savePaymentLabel({
                  txid: result.txid,
                  label: details.paymentLabel,
                  changeVouts: result.changeVouts,
                });
```

If `buildActiveSendTx` throws, do not call `savePaymentLabel`.

Do not persist on broadcast success. Do not persist again from the PSBT preview.

- [ ] **Step 4: Typecheck and tests**

Run:

```bash
bun test tests/unit/sqlite-tx-payment-labels.test.ts tests/unit/build-send-tx.test.ts tests/unit/payment-label-actions.test.ts tests/unit/tui-wallet-txs.test.ts
bun run typecheck
```

Expected: all PASS / no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/WalletModal.tsx
git commit -m "$(cat <<'EOF'
Require a payment label on send and store it at build.

EOF
)"
```

---

### Task 7: Show the payment label on the tx list

**Files:**
- Modify: `src/tui/components/Transactions.tsx`

**Interfaces:**
- Consumes: `WalletTxRow.paymentLabel`
- Produces: row suffix `  {paymentLabel}` only when the label is set

- [ ] **Step 1: Append the label to the tx row**

In `src/tui/components/Transactions.tsx`, change the mapped row to:

```tsx
          ? visibleTxs.map((tx) => (
              <text key={tx.txid}>
                <span fg={THEME.fg}>
                  {`${tx.timeLabel}  ${tx.shortTxid}  `}
                </span>
                <BtcAmount sats={BigInt(tx.netDeltaSats)} plus />
                {tx.paymentLabel ? (
                  <span fg={THEME.fg}>{`  ${tx.paymentLabel}`}</span>
                ) : null}
              </text>
            ))
```

When `paymentLabel` is null, the row stays as it is today.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`

Expected: no type errors

Also run: `bun test tests/unit/tui-wallet-txs.test.ts`

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/components/Transactions.tsx
git commit -m "$(cat <<'EOF'
Show payment labels on the transactions list.

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| `tx_payment_labels` table / repo | Task 1 |
| Persist at successful build | Task 3, Task 6 |
| Required details field, trim, reject empty | Task 6 |
| All send kinds (signed + PSBT) | Task 2 + Task 6 (same persist path) |
| `txid` + change vouts on build result | Task 2 |
| Send-max: label only, empty vouts | Task 2, Task 3 |
| Self-send skips payment output | Task 2 |
| Apply `change from: {label}` on parse | Task 3, Task 4 |
| Do not overwrite existing UTXO name | Task 3 |
| Keep payment-label row after apply | Task 3 |
| `WalletTxRow.paymentLabel` in snapshot | Task 5 |
| Tx list shows label | Task 7 |
| Preview help shows label | Task 6 |
| No tx-label edit UI | (no task; do not add) |
| No unused-row cleanup | (no task; do not add) |
