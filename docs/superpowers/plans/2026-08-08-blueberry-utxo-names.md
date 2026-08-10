# UTXO Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user rename focused UTXOs on the send selection screen (R), persist names in `utxo_names` keyed by `txid:vout`, and show names after the value bar.

**Architecture:** Add a dedicated SQLite `utxo_names` repository. Load names in `snapshotFromDb` onto `WalletUtxoRow.name`. A small active-context helper writes names and refreshes the wallet txs store. `SendBody` owns rename UI state; `WalletModal` skips Esc-close while renaming.

**Tech Stack:** Bun, TypeScript, bun:sqlite, existing TUI (`WalletModal`, `wallet-txs-store`, `@opentui/react` `input` / `useKeyboard`).

## Global Constraints

- Lookup key: `txid:vout` (same as `WalletUtxoRow.key`)
- Empty/whitespace submit: trim then delete row (clear name)
- Rename field: prefill with current name
- Spent UTXOs: keep name rows; no cleanup
- Esc while renaming: cancel rename only; do not close send modal
- Help text: `Esc to close · R to rename · Space to select · Enter to continue`
- Spec: `docs/superpowers/specs/2026-08-08-blueberry-utxo-names-design.md`

---

## File map

| File | Role |
|------|------|
| `src/db/schema.ts` | `CREATE TABLE utxo_names` |
| `src/db/types.ts` | `UtxoNamesRepository` + `Database.utxoNames` |
| `src/db/sqlite-database.ts` | Repository implementation |
| `tests/sqlite-utxo-names.test.ts` | Repo get/upsert/delete/list |
| `src/tui/wallet-txs-store.ts` | `WalletUtxoRow.name`; load names in `snapshotFromDb` |
| `tests/tui-wallet-txs.test.ts` | Snapshot includes names |
| `src/tui/utxo-names-actions.ts` | Active-context rename + snapshot refresh |
| `tests/utxo-names-actions.test.ts` | Trim/upsert/delete + store refresh |
| `src/main.tsx` | `setActiveUtxoNamesContext(...)` |
| `src/tui/components/WalletModal.tsx` | Help text, name column, R rename, Esc gate |

---

### Task 1: `utxo_names` schema and repository

**Files:**
- Modify: `src/db/schema.ts`
- Modify: `src/db/types.ts`
- Modify: `src/db/sqlite-database.ts`
- Create: `tests/sqlite-utxo-names.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - Table `utxo_names(outpoint TEXT PRIMARY KEY, name TEXT NOT NULL)`
  - `export type UtxoNameRow = { outpoint: string; name: string }`
  - `export interface UtxoNamesRepository { get(outpoint: string): string | null; upsert(outpoint: string, name: string): void; delete(outpoint: string): void; list(): UtxoNameRow[]; }`
  - `Database.utxoNames: UtxoNamesRepository`

- [ ] **Step 1: Write the failing test**

Create `tests/sqlite-utxo-names.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";

describe("utxo_names", () => {
  test("get/upsert/delete/list by outpoint", () => {
    const db = createSqliteDatabase(":memory:");
    const out = `${"aa".repeat(32)}:0`;

    expect(db.utxoNames.get(out)).toBeNull();
    expect(db.utxoNames.list()).toEqual([]);

    db.utxoNames.upsert(out, "cold storage");
    expect(db.utxoNames.get(out)).toBe("cold storage");
    expect(db.utxoNames.list()).toEqual([
      { outpoint: out, name: "cold storage" },
    ]);

    db.utxoNames.upsert(out, "renamed");
    expect(db.utxoNames.get(out)).toBe("renamed");

    db.utxoNames.delete(out);
    expect(db.utxoNames.get(out)).toBeNull();
    expect(db.utxoNames.list()).toEqual([]);

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sqlite-utxo-names.test.ts`  
Expected: FAIL — `utxoNames` missing on Database / not implemented

- [ ] **Step 3: Implement schema, types, repository**

In `src/db/schema.ts`, after `key_value` table:

```sql
CREATE TABLE IF NOT EXISTS utxo_names (
  outpoint TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
```

In `src/db/types.ts`:

```ts
export type UtxoNameRow = {
  outpoint: string;
  name: string;
};

export interface UtxoNamesRepository {
  get(outpoint: string): string | null;
  upsert(outpoint: string, name: string): void;
  delete(outpoint: string): void;
  list(): UtxoNameRow[];
}
```

Add `utxoNames: UtxoNamesRepository` to `Database`.

In `src/db/sqlite-database.ts`:
- Import `UtxoNamesRepository` (and `UtxoNameRow` if needed).
- Implement `utxoNames` with prepared statements:

```ts
const getUtxoName = raw.query(
  `SELECT name FROM utxo_names WHERE outpoint = ?`,
);
const upsertUtxoName = raw.query(
  `INSERT INTO utxo_names(outpoint, name) VALUES (?, ?)
   ON CONFLICT(outpoint) DO UPDATE SET name = excluded.name`,
);
const deleteUtxoName = raw.query(
  `DELETE FROM utxo_names WHERE outpoint = ?`,
);
const listUtxoNames = raw.query(
  `SELECT outpoint, name FROM utxo_names ORDER BY outpoint`,
);

const utxoNames: UtxoNamesRepository = {
  get(outpoint) {
    const row = getUtxoName.get(outpoint) as { name: string } | null;
    return row?.name ?? null;
  },
  upsert(outpoint, name) {
    upsertUtxoName.run(outpoint, name);
  },
  delete(outpoint) {
    deleteUtxoName.run(outpoint);
  },
  list() {
    return listUtxoNames.all() as { outpoint: string; name: string }[];
  },
};
```

Return `utxoNames` from `createSqliteDatabase`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sqlite-utxo-names.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/types.ts src/db/sqlite-database.ts tests/sqlite-utxo-names.test.ts
git commit -m "$(cat <<'EOF'
Add utxo_names table and repository.

EOF
)"
```

---

### Task 2: Load names into wallet UTXO snapshot

**Files:**
- Modify: `src/tui/wallet-txs-store.ts`
- Modify: `tests/tui-wallet-txs.test.ts`

**Interfaces:**
- Consumes: `Database.utxoNames.list()`
- Produces: `WalletUtxoRow.name: string | null` set in `snapshotFromDb`

- [ ] **Step 1: Write the failing test**

In `tests/tui-wallet-txs.test.ts`, extend the existing test `"snapshotFromDb lists UTXOs newest-first when wallet is provided"` (or add a sibling that reuses the same setup). After upserting the two txs and before `snapshotFromDb`:

```ts
db.utxoNames.upsert(`${newer.getId()}:0`, "lunch money");
```

Then assert:

```ts
expect(snap.utxos[0]?.name).toBe("lunch money");
expect(snap.utxos[1]?.name).toBeNull();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tui-wallet-txs.test.ts`  
Expected: FAIL — `name` missing / undefined on UTXO rows

- [ ] **Step 3: Implement snapshot field**

In `src/tui/wallet-txs-store.ts`, add to `WalletUtxoRow`:

```ts
/** User label from utxo_names; null when unset. */
name: string | null;
```

In `snapshotFromDb`, before mapping utxos:

```ts
const nameByOutpoint = new Map(
  db.utxoNames.list().map((r) => [r.outpoint, r.name]),
);
```

When building each row, add:

```ts
name: nameByOutpoint.get(key) ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tui-wallet-txs.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/wallet-txs-store.ts tests/tui-wallet-txs.test.ts
git commit -m "$(cat <<'EOF'
Load UTXO names into wallet txs snapshot.

EOF
)"
```

---

### Task 3: Active-context rename helper

**Files:**
- Create: `src/tui/utxo-names-actions.ts`
- Create: `tests/utxo-names-actions.test.ts`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `Database`, `Wallet`, `WalletTxsStore`, `snapshotFromDb`
- Produces:
  - `setActiveUtxoNamesContext(db: Database, wallet: Wallet, walletTxsStore: WalletTxsStore): void`
  - `setUtxoName(outpoint: string, name: string): void` — trim; empty → delete; else upsert; then `walletTxsStore.apply(snapshotFromDb(...))`

- [ ] **Step 1: Write the failing test**

Create `tests/utxo-names-actions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { Transaction } from "bitcoinjs-lib";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import {
  setActiveUtxoNamesContext,
  setUtxoName,
} from "../src/tui/utxo-names-actions.ts";
import {
  createWalletTxsStore,
  snapshotFromDb,
} from "../src/tui/wallet-txs-store.ts";
import { createWallet } from "../src/wallet/wallet.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function watchScript0(): Uint8Array {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const child = root.derive("m/84'/0'/0'/0/0");
  const { script } = p2wpkh(child.publicKey!);
  return new Uint8Array(script);
}

describe("setUtxoName", () => {
  test("trims, upserts, clears on empty, refreshes wallet store", () => {
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: MNEMONIC, addressGap: 4 });
    const store = createWalletTxsStore();
    setActiveUtxoNamesContext(db, wallet, store);

    const script = watchScript0();
    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(Buffer.alloc(32), 0xffffffff);
    tx.addOutput(script, 1000n);
    const outpoint = `${tx.getId()}:0`;
    db.transactions.upsert({
      txid: tx.getId(),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "aa".repeat(32),
      tx: tx.toBuffer(),
      netDeltaSats: 1000,
    });
    store.apply(snapshotFromDb(db, Date.now(), Date.now(), wallet));
    expect(store.get().utxos[0]?.name).toBeNull();

    setUtxoName(outpoint, "  coffee  ");
    expect(db.utxoNames.get(outpoint)).toBe("coffee");
    expect(store.get().utxos[0]?.name).toBe("coffee");

    setUtxoName(outpoint, "   ");
    expect(db.utxoNames.get(outpoint)).toBeNull();
    expect(store.get().utxos[0]?.name).toBeNull();

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/utxo-names-actions.test.ts`  
Expected: FAIL — module / exports missing

- [ ] **Step 3: Implement helper and wire main**

Create `src/tui/utxo-names-actions.ts`:

```ts
import type { Database } from "../db/types.ts";
import type { Wallet } from "../wallet/wallet.ts";
import type { WalletTxsStore } from "./wallet-txs-store.ts";
import { snapshotFromDb } from "./wallet-txs-store.ts";

type Ctx = {
  db: Database;
  wallet: Wallet;
  walletTxsStore: WalletTxsStore;
};

let active: Ctx | null = null;

export function setActiveUtxoNamesContext(
  db: Database,
  wallet: Wallet,
  walletTxsStore: WalletTxsStore,
): void {
  active = { db, wallet, walletTxsStore };
}

/** Persist a UTXO label. Trim; empty clears. Refreshes wallet txs snapshot. */
export function setUtxoName(outpoint: string, name: string): void {
  if (!active) throw new Error("utxo names context not initialized");
  const { db, wallet, walletTxsStore } = active;
  const trimmed = name.trim();
  if (trimmed === "") db.utxoNames.delete(outpoint);
  else db.utxoNames.upsert(outpoint, trimmed);
  const at = Date.now();
  walletTxsStore.apply(snapshotFromDb(db, at, at, wallet));
}
```

In `src/main.tsx`, after `setActiveSendContext(db, wallet)`:

```ts
import { setActiveUtxoNamesContext } from "./tui/utxo-names-actions.ts";
// ...
setActiveUtxoNamesContext(db, wallet, walletTxsStore);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/utxo-names-actions.test.ts`  
Expected: PASS

Also run: `bun test tests/sqlite-utxo-names.test.ts tests/tui-wallet-txs.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/utxo-names-actions.ts tests/utxo-names-actions.test.ts src/main.tsx
git commit -m "$(cat <<'EOF'
Add setUtxoName action with wallet snapshot refresh.

EOF
)"
```

---

### Task 4: UTXO selection UI — help, name column, rename

**Files:**
- Modify: `src/tui/components/WalletModal.tsx`

**Interfaces:**
- Consumes: `setUtxoName(outpoint, name)`, `WalletUtxoRow.name`
- Produces: rename UX on utxos step; Esc-close gated while renaming

- [ ] **Step 1: Update `UtxoLine` to show name after value bar**

Change `UtxoLine` so the trailing segment includes the name when present:

```tsx
function UtxoLine(props: {
  utxo: WalletUtxoRow;
  checked: boolean;
  focused: boolean;
}) {
  const mark = props.checked ? "[x]" : "[ ]";
  const fg = props.focused ? THEME.accentCyan : THEME.fg;
  const nameSuffix = props.utxo.name ? `  ${props.utxo.name}` : "";
  return (
    <text fg={fg} wrapMode="none">
      {`${mark} `}
      <BtcAmount sats={props.utxo.valueSats} fg={fg} />
      {`  ${props.utxo.outpointShort}  ${props.utxo.ageLabel}  ${props.utxo.valueBar}${nameSuffix}`}
    </text>
  );
}
```

- [ ] **Step 2: Add rename state + keys in `SendBody`**

Import `setUtxoName` from `../utxo-names-actions.ts`.

Extend `SendBody` props:

```ts
onRenamingChange?: (renaming: boolean) => void;
```

Inside `SendBody`:

```ts
const [renaming, setRenaming] = useState(false);
const [renameDraft, setRenameDraft] = useState("");

function beginRename() {
  const row = utxos[focused];
  if (!row) return;
  setRenameDraft(row.name ?? "");
  setRenaming(true);
  props.onRenamingChange?.(true);
}

function endRename(save: boolean) {
  if (save) {
    const row = utxos[focused];
    if (row) setUtxoName(row.key, renameDraft);
  }
  setRenaming(false);
  props.onRenamingChange?.(false);
}
```

Update the utxos-step `useKeyboard`:

```ts
useKeyboard((key) => {
  if (props.step !== "utxos") return;

  if (renaming) {
    if (key.name === "escape" || key.name === "esc") {
      endRename(false);
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      endRename(true);
      return;
    }
    return; // let <input> handle typing; ignore list keys
  }

  if (utxos.length === 0) return;
  if (key.name === "up") {
    moveFocus(Math.max(0, focused - 1));
    return;
  }
  if (key.name === "down") {
    moveFocus(Math.min(utxos.length - 1, focused + 1));
    return;
  }
  if (key.name === "r") {
    beginRename();
    return;
  }
  if (key.name === "space") {
    const row = utxos[focused];
    if (!row) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
    return;
  }
  if (
    (key.name === "return" || key.name === "enter") &&
    checked.size > 0
  ) {
    props.onUtxosContinue([...checked]);
  }
});
```

- [ ] **Step 3: Help text + rename input UI**

Replace the utxos-step header block with always-visible help (keep selected sum when useful):

```tsx
<text fg={THEME.fgDim}>
  {checked.size > 0 ? (
    <>
      {"Select UTXOs ("}
      <BtcAmount sats={selectedSum} />
      {") · Esc to close · R to rename · Space to select · Enter to continue"}
    </>
  ) : (
    "Esc to close · R to rename · Space to select · Enter to continue"
  )}
</text>
{renaming ? (
  <>
    <text fg={THEME.fgDim}>Rename UTXO</text>
    <input
      focused
      value={renameDraft}
      onInput={setRenameDraft}
    />
  </>
) : null}
```

Keep the UTXO list visible under the rename input. Focus stays on the input.

- [ ] **Step 4: Gate Esc-close in `WalletModal`**

In `WalletModal`:

```ts
const [utxoRenaming, setUtxoRenaming] = useState(false);
```

Reset when kind/send step resets:

```ts
useEffect(() => {
  if (kind === "send") {
    setSendStep("utxos");
    setSelectedKeys([]);
    setDetails(null);
    setPreview(null);
    setUtxoRenaming(false);
    broadcastStore?.reset();
  }
}, [kind, broadcastStore]);
```

Esc handler — early return while renaming:

```ts
useKeyboard((key) => {
  if (key.name === "escape" || key.name === "esc") {
    if (utxoRenaming) return;
    // ... existing broadcast / close logic
  }
});
```

Pass to `SendBody`:

```tsx
onRenamingChange={setUtxoRenaming}
```

- [ ] **Step 5: Typecheck and tests**

Run:

```bash
bun test tests/sqlite-utxo-names.test.ts tests/tui-wallet-txs.test.ts tests/utxo-names-actions.test.ts
bun run typecheck
```

Expected: all PASS / no type errors.

Manual check (optional in this task): open Send → UTXOs → R → type name → Enter → name appears after value bar; Esc during rename does not close modal; empty Enter clears name.

- [ ] **Step 6: Commit**

```bash
git add src/tui/components/WalletModal.tsx
git commit -m "$(cat <<'EOF'
Add UTXO rename UI on send selection screen.

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| `utxo_names` table / repo | Task 1 |
| `txid:vout` key | Task 1 |
| Empty submit clears | Task 3 |
| Prefill current name | Task 4 |
| Keep spent names | Task 1 (no cleanup code) |
| Names in snapshot | Task 2 |
| Help text Esc/R/Space/Enter | Task 4 |
| Name after value bar | Task 4 |
| R opens input | Task 4 |
| Esc cancels rename only | Task 4 |
| Refresh after save | Task 3 |
| Names ignored by send build | (no change; display-only) |
