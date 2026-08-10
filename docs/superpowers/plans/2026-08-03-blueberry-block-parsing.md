# blueberry Block Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse downloaded matched blocks with bitcoinjs-lib, persist wallet-relevant transactions, never parse the same block twice, and drive Balance + Transactions TUI from storage via `wallet:txs`.

**Architecture:** `parse-blocks` watches `blocks:progress` with busy/needsRun (same race pattern as filters-matching). Pure helpers under `src/parse/` decode via `Block.fromHex`, detect watch receives/spends (including P2WPKH witness for spend-before-receive), and recompute balance/net deltas by height order. SQLite gains `parsed_blocks` + `transactions`; TUI reloads on `wallet:txs`.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, `bitcoinjs-lib` 7.0.1 (`Block`, `Transaction`, `crypto.hash160`), existing MessageBus + Module + OpenTUI store pattern. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-03-blueberry-block-parsing-design.md`.
- Wake on existing `blocks:progress` only; emit `wallet:txs { at: number }` (init + after **each** parsed block).
- Track parsed heights in `parsed_blocks` — never `UPDATE blocks` (fat `block_hex`).
- Watch scripts from `deriveWatchWallet` / `ADDRESS_GAP` (same as filters-matching).
- No separate Balance domain module; no change to blocks-download emit shape.
- Out-of-order parse must still yield correct confirmed balance.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).

## File structure

| Path | Responsibility |
|------|----------------|
| `src/db/types.ts` | `StoredTx`, `ParsedBlocksRepository`, `TransactionsRepository`, extend `BlocksRepository` + `Database` |
| `src/db/schema.ts` | Create `parsed_blocks` + `transactions` |
| `src/db/sqlite-database.ts` | Implement new repos + `listNeedingParse` |
| `src/bus/types.ts` | Add `wallet:txs` |
| `src/parse/types.ts` | Parsed tx / UTXO / balance types |
| `src/parse/extract.ts` | `extractWatchTxs` from a `Block` |
| `src/parse/balance.ts` | Ordered UTXO unwrap, net deltas, balance |
| `src/parse/format.ts` | short txid, sats/BTC strings |
| `src/modules/parse-blocks.ts` | Module loop (replace scaffold) |
| `src/tui/wallet-txs-store.ts` | Hold listed txs + derived balance snapshot |
| `src/tui/use-wallet-txs.ts` | React hook |
| `src/tui/tui-module.ts` | Subscribe `wallet:txs`, seed from DB |
| `src/tui/components/Balance.tsx` | Render balance |
| `src/tui/components/Transactions.tsx` | Render tx list |
| `src/main.tsx` | Wire wallet-txs store into TUI module |
| `tests/sqlite-parsed-txs.test.ts` | DB APIs |
| `tests/parse-extract.test.ts` | Relevance + spend-before-receive |
| `tests/parse-balance.test.ts` | Out-of-order balance |
| `tests/parse-blocks.test.ts` | Module behavior |
| `tests/tui-wallet-txs.test.ts` | Bus → store wiring |

---

### Task 1: SQLite `parsed_blocks` + `transactions`

**Files:**
- Modify: `src/db/types.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/db/sqlite-database.ts`
- Create: `tests/sqlite-parsed-txs.test.ts`

**Interfaces:**
- Consumes: existing `createSqliteDatabase`, `migrate`, `BlocksRepository`
- Produces:

```ts
export type StoredTx = {
  txid: string; // display-order hex
  height: number;
  txIndex: number;
  blockHashInternalHex: string;
  hex: string;
  netDeltaSats: number;
};

export interface ParsedBlocksRepository {
  has(height: number): boolean;
  mark(height: number): void; // INSERT OR IGNORE
  count(): number;
}

export interface TransactionsRepository {
  upsert(tx: StoredTx): void;
  list(): StoredTx[]; // height DESC, tx_index DESC
  count(): number;
  setNetDelta(txid: string, netDeltaSats: number): void;
}

// On BlocksRepository:
listNeedingParse(limit: number): DownloadedBlock[];

// On Database:
parsedBlocks: ParsedBlocksRepository;
transactions: TransactionsRepository;
```

- [ ] **Step 1: Write the failing DB test**

Create `tests/sqlite-parsed-txs.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";

describe("parsed blocks + transactions", () => {
  test("listNeedingParse, mark, upsert, list order, setNetDelta", () => {
    const db = createSqliteDatabase(":memory:");
    db.blocks.insert({
      height: 10,
      blockHashInternalHex: "aa".repeat(32),
      blockHex: "11",
    });
    db.blocks.insert({
      height: 11,
      blockHashInternalHex: "bb".repeat(32),
      blockHex: "22",
    });
    db.blocks.insert({
      height: 12,
      blockHashInternalHex: "cc".repeat(32),
      blockHex: "33",
    });

    expect(db.blocks.listNeedingParse(10).map((b) => b.height)).toEqual([
      10, 11, 12,
    ]);
    expect(db.blocks.listNeedingParse(1).map((b) => b.height)).toEqual([10]);

    db.parsedBlocks.mark(11);
    expect(db.parsedBlocks.has(11)).toBe(true);
    expect(db.parsedBlocks.count()).toBe(1);
    expect(db.blocks.listNeedingParse(10).map((b) => b.height)).toEqual([
      10, 12,
    ]);

    db.parsedBlocks.mark(11); // idempotent
    expect(db.parsedBlocks.count()).toBe(1);

    db.transactions.upsert({
      txid: "a".repeat(64),
      height: 12,
      txIndex: 1,
      blockHashInternalHex: "cc".repeat(32),
      hex: "aa",
      netDeltaSats: 100,
    });
    db.transactions.upsert({
      txid: "b".repeat(64),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "aa".repeat(32),
      hex: "bb",
      netDeltaSats: 50,
    });
    db.transactions.upsert({
      txid: "a".repeat(64),
      height: 12,
      txIndex: 1,
      blockHashInternalHex: "cc".repeat(32),
      hex: "aa",
      netDeltaSats: 999, // replace
    });

    expect(db.transactions.count()).toBe(2);
    expect(db.transactions.list().map((t) => t.txid)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(db.transactions.list()[0]?.netDeltaSats).toBe(999);

    db.transactions.setNetDelta("a".repeat(64), 42);
    expect(db.transactions.list()[0]?.netDeltaSats).toBe(42);

    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/sqlite-parsed-txs.test.ts`

Expected: FAIL (missing types/methods/tables).

- [ ] **Step 3: Implement schema + types + sqlite**

In `src/db/schema.ts` inside the main `raw.exec(\`...\`)` block, add:

```sql
CREATE TABLE IF NOT EXISTS parsed_blocks (
  height INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS transactions (
  txid TEXT PRIMARY KEY,
  height INTEGER NOT NULL,
  tx_index INTEGER NOT NULL,
  block_hash_internal_hex TEXT NOT NULL,
  hex TEXT NOT NULL,
  net_delta_sats INTEGER NOT NULL
);
```

In `src/db/types.ts`, add `StoredTx`, `ParsedBlocksRepository`, `TransactionsRepository`, `listNeedingParse` on `BlocksRepository`, and the two new fields on `Database`.

In `src/db/sqlite-database.ts`:

```ts
// listNeedingParse
`SELECT b.height, b.block_hash_internal_hex, b.block_hex
 FROM blocks b
 LEFT JOIN parsed_blocks p ON p.height = b.height
 WHERE p.height IS NULL
 ORDER BY b.height ASC
 LIMIT ?`

// parsedBlocks.mark: INSERT OR IGNORE INTO parsed_blocks(height) VALUES (?)
// transactions.upsert: INSERT ... ON CONFLICT(txid) DO UPDATE SET ...
// transactions.list: ORDER BY height DESC, tx_index DESC
// Return parsedBlocks + transactions from createSqliteDatabase
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/sqlite-parsed-txs.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/db/types.ts src/db/schema.ts src/db/sqlite-database.ts tests/sqlite-parsed-txs.test.ts
git commit -m "Add parsed_blocks and transactions storage."
```

---

### Task 2: Parse helpers (extract, balance, format)

**Files:**
- Create: `src/parse/types.ts`
- Create: `src/parse/extract.ts`
- Create: `src/parse/balance.ts`
- Create: `src/parse/format.ts`
- Create: `tests/parse-extract.test.ts`
- Create: `tests/parse-balance.test.ts`

**Interfaces:**
- Consumes: `bitcoinjs-lib` `Block`, `Transaction`, `crypto.hash160`; watch scripts as `Uint8Array[]`
- Produces:

```ts
// src/parse/types.ts
export type WatchUtxo = {
  value: bigint;
  scriptPubKey: Uint8Array;
};

export type ExtractedWatchTx = {
  txid: string;
  txIndex: number;
  hex: string;
};

export type BalanceSummary = {
  sats: bigint;
  utxoCount: number;
};

// src/parse/extract.ts
export function scriptHex(script: Uint8Array): string;
export function outpointKey(txidDisplay: string, vout: number): string;
/** Prevout txid display hex from bitcoinjs input.hash (internal byte order). */
export function prevoutTxidDisplay(inputHash: Uint8Array): string;
export function p2wpkhScriptFromPubkey(pubkey: Uint8Array): Uint8Array;
export function extractWatchTxs(
  block: Block,
  watchScripts: Uint8Array[],
  priorUtxos: Map<string, WatchUtxo>,
): ExtractedWatchTx[];

// src/parse/balance.ts
export function buildUtxoMap(
  txs: Array<{ txid: string; height: number; txIndex: number; hex: string }>,
  watchScripts: Uint8Array[],
): Map<string, WatchUtxo>;
export function netDeltasForTxs(
  txs: Array<{ txid: string; height: number; txIndex: number; hex: string }>,
  watchScripts: Uint8Array[],
): Map<string, bigint>;
export function balanceFromTxs(
  txs: Array<{ txid: string; height: number; txIndex: number; hex: string }>,
  watchScripts: Uint8Array[],
): BalanceSummary;

// src/parse/format.ts
export function shortTxid(txid: string, keep?: number): string;
export function formatSats(sats: bigint): string;
export function formatBtc(sats: bigint): string;
export function formatNetDelta(sats: bigint): string; // "+100" / "-50"
```

**Relevance rules (implement exactly):**
1. Output script ∈ watch set → relevant.
2. Non-coinbase input outpoint ∈ `priorUtxos` or created earlier in this block by a watch output → relevant.
3. Non-coinbase input with witness `[sig, pubkey]` where `p2wpkh(pubkey)` ∈ watch set → relevant (spend-before-receive).

- [ ] **Step 1: Write failing extract + balance tests**

`tests/parse-extract.test.ts` — build txs/blocks with bitcoinjs-lib:

```ts
import { describe, expect, test } from "bun:test";
import { Block, Transaction, crypto } from "bitcoinjs-lib";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { extractWatchTxs } from "../src/parse/extract.ts";
import { balanceFromTxs, netDeltasForTxs } from "../src/parse/balance.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function watchScript0(): { script: Uint8Array; pubkey: Uint8Array } {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const child = root.derive("m/84'/0'/0'/0/0");
  const pubkey = child.publicKey!;
  const { script } = p2wpkh(pubkey);
  return { script: new Uint8Array(script), pubkey: new Uint8Array(pubkey) };
}

function wrapBlock(txs: Transaction[]): Block {
  const block = new Block();
  block.version = 1;
  block.prevHash = new Uint8Array(32);
  block.merkleRoot = Block.calculateMerkleRoot(txs);
  block.timestamp = 0;
  block.bits = 0;
  block.nonce = 0;
  block.transactions = txs;
  return block;
}

describe("extractWatchTxs", () => {
  test("keeps receive to watch script; ignores unrelated", () => {
    const { script } = watchScript0();
    const hit = new Transaction();
    hit.version = 2;
    hit.addOutput(script, 1000n);
    const miss = new Transaction();
    miss.version = 2;
    miss.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 500n);
    const block = wrapBlock([hit, miss]);
    const found = extractWatchTxs(block, [script], new Map());
    expect(found.map((t) => t.txid)).toEqual([hit.getId()]);
  });

  test("detects P2WPKH spend via witness without prior utxo", () => {
    const { script, pubkey } = watchScript0();
    const spend = new Transaction();
    spend.version = 2;
    spend.addInput(new Uint8Array(32).fill(1), 0);
    spend.setWitness(0, [new Uint8Array(64), pubkey]);
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 900n);
    const block = wrapBlock([spend]);
    const found = extractWatchTxs(block, [script], new Map());
    expect(found).toHaveLength(1);
    expect(found[0]!.txid).toBe(spend.getId());
  });
});
```

`tests/parse-balance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Transaction } from "bitcoinjs-lib";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { balanceFromTxs, netDeltasForTxs } from "../src/parse/balance.ts";

// same watchScript0 helper as above…

describe("balanceFromTxs", () => {
  test("spend-before-receive insert order still balances", () => {
    const { script, pubkey } = watchScript0();
    const receive = new Transaction();
    receive.version = 2;
    receive.addOutput(script, 1000n);

    const spend = new Transaction();
    spend.version = 2;
    const prevHash = Buffer.from(receive.getId(), "hex").reverse();
    spend.addInput(new Uint8Array(prevHash), 0);
    spend.setWitness(0, [new Uint8Array(64), pubkey]);
    spend.addOutput(new Uint8Array([0x00, 0x14, ...new Uint8Array(20)]), 900n);

    // Persist order: spend first (height 101), receive second (height 100)
    const rows = [
      { txid: spend.getId(), height: 101, txIndex: 0, hex: spend.toHex() },
      { txid: receive.getId(), height: 100, txIndex: 0, hex: receive.toHex() },
    ];
    expect(balanceFromTxs(rows, [script])).toEqual({
      sats: 0n,
      utxoCount: 0,
    });
    const deltas = netDeltasForTxs(rows, [script]);
    expect(deltas.get(receive.getId())).toBe(1000n);
    expect(deltas.get(spend.getId())).toBe(-1000n);
  });
});
```

Also add a small format test in `tests/parse-balance.test.ts` or inline in extract file for `shortTxid` / `formatBtc` (`1000n` → `"0.00001000 BTC"`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/parse-extract.test.ts tests/parse-balance.test.ts`

Expected: FAIL (modules missing).

- [ ] **Step 3: Implement helpers**

`extract.ts` sketch:

```ts
import { Block, Transaction, crypto } from "bitcoinjs-lib";
import type { ExtractedWatchTx, WatchUtxo } from "./types.ts";

export function scriptHex(script: Uint8Array): string {
  return Buffer.from(script).toString("hex");
}

export function prevoutTxidDisplay(inputHash: Uint8Array): string {
  return Buffer.from(inputHash).reverse().toString("hex");
}

export function p2wpkhScriptFromPubkey(pubkey: Uint8Array): Uint8Array {
  const h = crypto.hash160(pubkey);
  return new Uint8Array([0x00, 0x14, ...h]);
}

export function extractWatchTxs(
  block: Block,
  watchScripts: Uint8Array[],
  priorUtxos: Map<string, WatchUtxo>,
): ExtractedWatchTx[] {
  const watch = new Set(watchScripts.map(scriptHex));
  const utxos = new Map(priorUtxos);
  const out: ExtractedWatchTx[] = [];
  const txs = block.transactions ?? [];
  for (let i = 0; i < txs.length; i++) {
    const tx = txs[i]!;
    let relevant = false;
    if (!tx.isCoinbase()) {
      for (const inn of tx.ins) {
        const key = `${prevoutTxidDisplay(inn.hash)}:${inn.index}`;
        if (utxos.has(key)) {
          relevant = true;
          break;
        }
        const wit = inn.witness;
        if (wit.length >= 2) {
          const pk = wit[wit.length - 1]!;
          if (pk.length === 33 && watch.has(scriptHex(p2wpkhScriptFromPubkey(pk)))) {
            relevant = true;
            break;
          }
        }
      }
    }
    for (const outp of tx.outs) {
      if (watch.has(scriptHex(outp.script))) relevant = true;
    }
    if (relevant) {
      out.push({ txid: tx.getId(), txIndex: i, hex: tx.toHex() });
      // apply creates/spends into utxos for same-block chaining
      if (!tx.isCoinbase()) {
        for (const inn of tx.ins) {
          utxos.delete(`${prevoutTxidDisplay(inn.hash)}:${inn.index}`);
        }
      }
      tx.outs.forEach((o, vout) => {
        if (watch.has(scriptHex(o.script))) {
          utxos.set(`${tx.getId()}:${vout}`, {
            value: o.value,
            scriptPubKey: o.script,
          });
        }
      });
    }
  }
  return out;
}
```

`balance.ts`: sort by `(height, txIndex)`, walk with `Transaction.fromHex`, credit watch outs, debit known watch spends (resolve value from map; if missing but witness matches watch, still need value from map — after receive is applied in order, spend works). Return sats sum of remaining UTXOs and per-txid net deltas.

`format.ts`:

```ts
export function shortTxid(txid: string, keep = 8): string {
  if (txid.length <= keep * 2) return txid;
  return `${txid.slice(0, keep)}…${txid.slice(-keep)}`;
}
export function formatSats(sats: bigint): string {
  return `${sats.toString()} sats`;
}
export function formatBtc(sats: bigint): string {
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const whole = abs / 100000000n;
  const frac = (abs % 100000000n).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${whole}.${frac} BTC`;
}
export function formatNetDelta(sats: bigint): string {
  const sign = sats > 0n ? "+" : "";
  return `${sign}${sats.toString()}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/parse-extract.test.ts tests/parse-balance.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/parse tests/parse-extract.test.ts tests/parse-balance.test.ts
git commit -m "Add block parse helpers for watch txs and balance."
```

---

### Task 3: `parse-blocks` module + bus event

**Files:**
- Modify: `src/bus/types.ts`
- Modify: `src/modules/parse-blocks.ts` (replace scaffold)
- Create: `tests/parse-blocks.test.ts`

**Interfaces:**
- Consumes: `ModuleContext`, `deriveWatchWallet`, `Block.fromHex`, `extractWatchTxs`, `buildUtxoMap`, `netDeltasForTxs`, DB repos from Task 1
- Produces: module that emits `wallet:txs` and `module:status`

```ts
// EventMap addition
"wallet:txs": { at: number };

export type ParseBlocksOptions = {
  seed?: string;
  addressGap?: number;
  batchSize?: number;
  idleDelayMs?: number;
  now?: () => number;
};

export function createParseBlocksModule(
  ctx: ModuleContext,
  options?: ParseBlocksOptions,
): Module;
```

**Loop behavior (mirror filters-matching):**
- `busy` / `needsRun` / `waitForKick`
- On `blocks:progress`: if `busy` → `needsRun = true`; else `kick()`
- Parse batch: `listNeedingParse(batchSize)` → for each block `Block.fromHex` → `extractWatchTxs` with `buildUtxoMap(db.transactions.list(), scripts)` → upsert → `parsedBlocks.mark` → emit `wallet:txs` (recompute net deltas when the block wrote txs) → refresh utxo map
- After batch (or empty init): also `netDeltasForTxs` + emit (safety net / empty backlog)
- Decode error: emit `module:status` error detail for that block; do not mark parsed; continue remaining batch
- start: status starting → derive wallet → run once → emit `wallet:txs` → subscribe → status running → background loop
- stop: unsubscribe, kick, await loop

- [ ] **Step 1: Write the failing module test**

```ts
import { describe, expect, test } from "bun:test";
import { Block, Transaction } from "bitcoinjs-lib";
import { p2wpkh } from "@scure/btc-signer";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../src/modules/parse-blocks.ts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("timeout"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function watchScript0(): Uint8Array {
  const root = HDKey.fromMasterSeed(mnemonicToSeedSync(MNEMONIC));
  const child = root.derive("m/84'/0'/0'/0/0");
  return new Uint8Array(p2wpkh(child.publicKey!).script);
}

function blockHexWithReceive(script: Uint8Array, value: bigint): string {
  const tx = new Transaction();
  tx.version = 2;
  tx.addOutput(script, value);
  const block = new Block();
  block.version = 1;
  block.prevHash = new Uint8Array(32);
  block.merkleRoot = Block.calculateMerkleRoot([tx]);
  block.timestamp = 0;
  block.bits = 0;
  block.nonce = 0;
  block.transactions = [tx];
  return block.toHex();
}

describe("parse-blocks", () => {
  test("parses backlog on start and emits wallet:txs", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    const hex = blockHexWithReceive(script, 5000n);
    db.blocks.insert({
      height: 50,
      blockHashInternalHex: "ab".repeat(32),
      blockHex: hex,
    });

    const events: number[] = [];
    bus.on("wallet:txs", (p) => events.push(p.at));

    const mod = createParseBlocksModule(
      { bus, db },
      { seed: MNEMONIC, addressGap: 4, idleDelayMs: 50 },
    );
    await mod.start();
    await waitFor(() => db.parsedBlocks.has(50) && db.transactions.count() === 1);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(db.transactions.list()[0]?.netDeltaSats).toBe(5000);

    // second start path: already parsed — still emits wallet:txs, no double insert
    await mod.stop();
    const before = events.length;
    const mod2 = createParseBlocksModule(
      { bus, db },
      { seed: MNEMONIC, addressGap: 4, idleDelayMs: 50 },
    );
    await mod2.start();
    await waitFor(() => events.length > before);
    expect(db.transactions.count()).toBe(1);
    await mod2.stop();
    db.close();
  });

  test("blocks:progress while busy sets needsRun without overlapping parses", async () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const script = watchScript0();
    // Start with one block; inject second via progress while first parse holds.
    // Implementation under test: expose optional onParseBlock hook OR rely on
    // inserting a second block + emitting progress during first run.
    db.blocks.insert({
      height: 1,
      blockHashInternalHex: "11".repeat(32),
      blockHex: blockHexWithReceive(script, 1n),
    });

    let parses = 0;
    const mod = createParseBlocksModule(
      { bus, db },
      {
        seed: MNEMONIC,
        addressGap: 4,
        idleDelayMs: 20,
        batchSize: 1,
        // test seam:
        onParseBatch: async () => {
          parses++;
          if (parses === 1) {
            db.blocks.insert({
              height: 2,
              blockHashInternalHex: "22".repeat(32),
              blockHex: blockHexWithReceive(script, 2n),
            });
            bus.emit("blocks:progress", {
              at: Date.now(),
              downloaded: 2,
              matched: 2,
            });
          }
        },
      },
    );
    await mod.start();
    await waitFor(() => db.parsedBlocks.has(1) && db.parsedBlocks.has(2));
    expect(db.transactions.count()).toBe(2);
    await mod.stop();
    db.close();
  });
});
```

Add optional `onParseBatch?: () => Promise<void> | void` to `ParseBlocksOptions` as a test seam (call at start of each batch while `busy` is true).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/parse-blocks.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement module + bus type**

Replace `src/modules/parse-blocks.ts` scaffold with the real module (structure modeled on `src/modules/filters-matching.ts`). Add `"wallet:txs"` to `EventMap` in `src/bus/types.ts`.

After each parsed block (and after empty backlog on init), emit `wallet:txs`. When the block wrote txs (or at batch end as safety net), recompute deltas:

```ts
const rows = db.transactions.list();
const deltas = netDeltasForTxs(rows, wallet.scripts);
for (const row of rows) {
  const d = deltas.get(row.txid) ?? 0n;
  if (BigInt(row.netDeltaSats) !== d) {
    db.transactions.setNetDelta(row.txid, Number(d));
  }
}
ctx.bus.emit("wallet:txs", { at: now() });
```

Note: `netDeltaSats` is INTEGER; values fit JS number for normal wallet amounts in tests. Use `Number(d)` only when `|d| <= Number.MAX_SAFE_INTEGER`; for this wallet watch app that is acceptable — document in code comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/parse-blocks.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/bus/types.ts src/modules/parse-blocks.ts tests/parse-blocks.test.ts
git commit -m "Implement parse-blocks module with wallet:txs events."
```

---

### Task 4: TUI Balance + Transactions on `wallet:txs`

**Files:**
- Create: `src/tui/wallet-txs-store.ts`
- Create: `src/tui/use-wallet-txs.ts`
- Modify: `src/tui/tui-module.ts`
- Modify: `src/tui/components/Balance.tsx`
- Modify: `src/tui/components/Transactions.tsx`
- Modify: `src/main.tsx`
- Create: `tests/tui-wallet-txs.test.ts`
- Modify: existing TUI module tests that construct `createTuiModule` (add new store arg)

**Interfaces:**
- Consumes: `StoredTx`, `balanceFromTxs`, format helpers, `wallet:txs` bus event, `db.transactions.list()`, `config.seed` / watch scripts for balance (store should hold precomputed view model — compute in tui-module when applying event)
- Produces:

```ts
export type WalletTxRow = {
  txid: string;
  shortTxid: string;
  height: number;
  netDeltaSats: number;
  netDeltaLabel: string;
};

export type WalletTxsSnapshot = {
  at: number | null;
  balanceSats: bigint;
  balanceBtcLabel: string;
  balanceSatsLabel: string;
  txs: WalletTxRow[];
};

export type WalletTxsStore = {
  get(): WalletTxsSnapshot;
  apply(snapshot: WalletTxsSnapshot): void;
  subscribe(listener: () => void): () => void;
};

export function createWalletTxsStore(): WalletTxsStore;
export function useWalletTxs(): WalletTxsSnapshot;

// createTuiModule(..., walletTxsStore: WalletTxsStore)
// helper used by tui-module:
export function snapshotFromDb(
  db: Database,
  watchScripts: Uint8Array[],
  at: number,
): WalletTxsSnapshot;
```

Because TUI should not need the mnemonic if parse already wrote `net_delta_sats`, Balance can sum UTXOs via `balanceFromTxs` **or** sum positive unspent by re-deriving scripts from `config.seed` in tui-module (same as matching). Prefer: tui-module imports `deriveWatchWallet(config.seed)` once at start for `balanceFromTxs`, and uses stored `netDeltaSats` for list labels (refresh labels from `netDeltasForTxs` if desired).

- [ ] **Step 1: Write failing TUI wiring test**

```ts
import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createWalletTxsStore } from "../src/tui/wallet-txs-store.ts";
import { createTuiModule } from "../src/tui/tui-module.ts";
import { createModuleStatusStore } from "../src/tui/status-store.ts";
import { createPeerCountStore } from "../src/tui/peer-count-store.ts";
import { createHeadersProgressStore } from "../src/tui/headers-progress-store.ts";
import { createFiltersProgressStore } from "../src/tui/filters-progress-store.ts";
import { createMatchingProgressStore } from "../src/tui/matching-progress-store.ts";
import { createBlocksMatchedStore } from "../src/tui/blocks-matched-store.ts";

describe("TUI wallet txs wiring", () => {
  test("wallet:txs reloads txs from db into store", () => {
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.transactions.upsert({
      txid: "ab".repeat(32),
      height: 9,
      txIndex: 0,
      blockHashInternalHex: "cd".repeat(32),
      hex: "00",
      netDeltaSats: 123,
    });
    const walletTxsStore = createWalletTxsStore();
    const tui = createTuiModule(
      { bus, db },
      createModuleStatusStore(),
      createPeerCountStore(),
      createHeadersProgressStore(),
      createFiltersProgressStore(),
      createMatchingProgressStore(),
      createBlocksMatchedStore(),
      walletTxsStore,
    );
    tui.start();
    // seed should already load the row
    expect(walletTxsStore.get().txs).toHaveLength(1);
    expect(walletTxsStore.get().txs[0]?.netDeltaSats).toBe(123);

    db.transactions.upsert({
      txid: "ef".repeat(32),
      height: 10,
      txIndex: 0,
      blockHashInternalHex: "cd".repeat(32),
      hex: "00",
      netDeltaSats: -50,
    });
    bus.emit("wallet:txs", { at: 42 });
    expect(walletTxsStore.get().at).toBe(42);
    expect(walletTxsStore.get().txs).toHaveLength(2);
    tui.stop();
    db.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tui-wallet-txs.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement store, hook, tui-module, components, main**

`Balance.tsx`:

```tsx
import { Panel } from "../chrome.tsx";
import { THEME } from "../theme.ts";
import { useWalletTxs } from "../use-wallet-txs.ts";

export function Balance() {
  const w = useWalletTxs();
  const active = w.balanceSats !== 0n || w.txs.length > 0;
  return (
    <Panel title="Balance" state={active ? "active" : "idle"} accent="magenta">
      <text fg={THEME.fg}>{w.balanceBtcLabel}</text>
      <text fg={THEME.fgDim}>{w.balanceSatsLabel}</text>
    </Panel>
  );
}
```

`Transactions.tsx`:

```tsx
import { Panel } from "../chrome.tsx";
import { THEME } from "../theme.ts";
import { useModuleStatus } from "../use-module-status.ts";
import { useWalletTxs } from "../use-wallet-txs.ts";

export function Transactions() {
  const status = useModuleStatus("parse-blocks");
  const w = useWalletTxs();
  const active = status !== "idle" || w.txs.length > 0;
  return (
    <Panel
      title="Transactions"
      state={active ? "active" : "idle"}
      accent="cyan"
    >
      {w.txs.length === 0 ? (
        <text fg={THEME.fgDim}>{status}</text>
      ) : (
        w.txs.map((tx) => (
          <text key={tx.txid} fg={THEME.fg}>
            {`${tx.height}  ${tx.shortTxid}  ${tx.netDeltaLabel}`}
          </text>
        ))
      )}
    </Panel>
  );
}
```

Wire `main.tsx`: create store, `setActiveWalletTxsStore`, pass into `createTuiModule`.

Update every `createTuiModule(` call site in tests with `createWalletTxsStore()`.

For balance without full tx hex decode in seed path when hex is dummy `"00"`: store may show `0` balance in the wiring test — that is fine. In production hex is real; `snapshotFromDb` calls `balanceFromTxs` and catches decode errors by falling back to summing `netDeltaSats` only if needed. Prefer: if `balanceFromTxs` throws on bad hex, fall back to `txs.reduce((s, t) => s + BigInt(t.netDeltaSats), 0n)` for robustness in tests.

- [ ] **Step 4: Run tests + typecheck**

Run:

```bash
bun test tests/tui-wallet-txs.test.ts tests/parse-blocks.test.ts tests/parse-extract.test.ts tests/parse-balance.test.ts tests/sqlite-parsed-txs.test.ts
bun test
bun run typecheck
```

Expected: all PASS.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/tui src/main.tsx tests/tui-wallet-txs.test.ts tests/tui-*.test.ts
git commit -m "Wire Balance and Transactions to wallet:txs."
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|------------------|------|
| Parse on init if unparsed blocks | Task 3 |
| Save parsed heights; never twice | Task 1 + 3 |
| Idle + `blocks:progress` + ignore while busy | Task 3 |
| `Block.fromHex` / bitcoinjs-lib | Task 2 + 3 |
| Watch addresses from wallet derive | Task 3 |
| Persist relevant txs | Task 1 + 2 + 3 |
| Emit for TUI; Balance + Transactions | Task 3 + 4 |
| Out-of-order correct (witness + ordered balance) | Task 2 |
| Init event for existing data | Task 3 + 4 |
| No Balance module; reuse `blocks:progress` | Tasks 3–4 |

No TBD placeholders. Types aligned across tasks (`StoredTx`, `wallet:txs`, `listNeedingParse`, `onParseBatch` seam).
