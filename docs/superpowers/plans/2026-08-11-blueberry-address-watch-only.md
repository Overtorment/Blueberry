# Single-address watch-only import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow onboarding import of a mainnet Bitcoin address as a fixed one-script watch-only wallet (balance/history/receive; unsigned PSBT send with change back to the same address).

**Architecture:** Add secret kind `"address"` detected via `isAddressValid` after WIF checks. Derive a `WatchWallet` with `kind: "address"` and exactly one script. Reuse the zpub send path (unsigned PSBT); skip HD gap growth like WIF. Wire receive/change to the sole watched address.

**Tech Stack:** Bun, TypeScript, `@scure/btc-signer`, `bitcoinjs-lib` (address → script), existing onboarding TUI.

**Spec:** `docs/superpowers/specs/2026-08-11-blueberry-address-watch-only-design.md`

## Global Constraints

- Mainnet only — addresses must pass existing `isAddressValid` (legacy / nested / native / taproot).
- Storage remains plaintext `wallet_secret` KV (trimmed address string).
- Detection order: zpub → reject other xpubs → WIF → **address** → BIP39 mnemonic.
- Never sign for `"address"` secrets; always unsigned PSBT.
- Change always returns to the watched address (non-max); send-max uses payee.
- No multi-address lists, no redeemScript recovery for nested P2SH, no testnet.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/wallet/secret.ts` | Detect/validate `"address"`; extend `WalletSecretKind` |
| `src/wallet/types.ts` | `WatchWalletKind` includes `"address"` |
| `src/wallet/derive.ts` | `deriveAddressWatchWallet` — one script + scriptType label |
| `src/wallet/build-send-tx.ts` | `AccountKey` address branch; script/UTXO PSBT inputs; taproot `p2tr` from address |
| `src/tui/send-context.ts` | Change = sole watched address when `kind === "address"` |
| `src/tui/receive-address-store.ts` | Receive = sole watched address when `kind === "address"` |
| `src/modules/parse-blocks.ts` | `maybeGrowWatch` no-op for `"address"` |
| `src/tui/OnboardingApp.tsx` | Prompt/placeholder mention address |
| `tests/unit/address-watch-wallet.test.ts` | New: parse / derive / receive / send / gaps |

---

### Task 1: Parse `"address"` secret kind

**Files:**
- Modify: `src/wallet/secret.ts`
- Modify: `src/wallet/types.ts` (only if needed later — prefer Task 2 for `WatchWalletKind`)
- Test: `tests/unit/address-watch-wallet.test.ts` (create)

**Interfaces:**
- Consumes: `isAddressValid` from `src/wallet/is-address-valid.ts`
- Produces: `WalletSecretKind` includes `"address"`; `parseWalletSecret(raw)` returns `{ kind: "address", value: trimmed }`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/address-watch-wallet.test.ts`:

```typescript
/**
 * Single-address watch-only — vectors reuse BlueWallet WIF primary addresses
 * and BIP-341 taproot example from is-address-valid tests.
 */
import { describe, expect, test } from "bun:test";
import { parseWalletSecret } from "../../src/wallet/secret.ts";

const ADDR_BECH32 = "bc1q3rl0mkyk0zrtxfmqn9wpcd3gnaz00yv9yp0hxe";
const ADDR_LEGACY = "14YZ6iymQtBVQJk6gKnLCk49UScJK7SH4M";
const ADDR_P2SH = "3CKN8HTCews4rYJYsyub5hjAVm5g5VFdQJ";
const ADDR_TAPROOT =
  "bc1pm6lqlel3qxefsx0v39nshtghasvvp6ghn3e5hd5q280j5m9h7csqrkzssu";
const BIP341_TAPROOT =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";

describe("parseWalletSecret address", () => {
  test("accepts mainnet legacy / nested / native / taproot (trimmed)", () => {
    expect(parseWalletSecret(`  ${ADDR_BECH32}  `)).toEqual({
      kind: "address",
      value: ADDR_BECH32,
    });
    expect(parseWalletSecret(ADDR_LEGACY).kind).toBe("address");
    expect(parseWalletSecret(ADDR_P2SH).kind).toBe("address");
    expect(parseWalletSecret(ADDR_TAPROOT).kind).toBe("address");
    expect(parseWalletSecret(BIP341_TAPROOT).kind).toBe("address");
  });

  test("rejects testnet and garbage before falling through to mnemonic", () => {
    expect(() =>
      parseWalletSecret("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"),
    ).toThrow(/mnemonic|address|invalid/i);
    expect(() => parseWalletSecret("not-an-address")).toThrow();
  });

  test("WIF still wins over address-shaped confusion", () => {
    const wif = "L4vn2KxgMLrEVpxjfLwxfjnPPQMnx42DCjZJ2H7nN4mdHDyEUWXd";
    expect(parseWalletSecret(wif).kind).toBe("wif");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/address-watch-wallet.test.ts`

Expected: FAIL — `kind` is not `"address"` (address falls through to invalid mnemonic).

- [ ] **Step 3: Minimal implementation**

In `src/wallet/secret.ts`:

1. Import `isAddressValid` from `./is-address-valid.ts`.
2. Extend: `export type WalletSecretKind = "mnemonic" | "zpub" | "wif" | "address";`
3. In `parseWalletSecret`, after the WIF block and **before** the mnemonic check:

```typescript
  if (isAddressValid(value)) {
    return { kind: "address", value };
  }
```

Do not change zpub / WIF / xpub-reject order.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/address-watch-wallet.test.ts`

Expected: PASS for `parseWalletSecret address` describe block.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/secret.ts tests/unit/address-watch-wallet.test.ts
git commit -m "$(cat <<'EOF'
feat: parse mainnet address as wallet secret kind.

EOF
)"
```

---

### Task 2: Derive one-script `WatchWallet`

**Files:**
- Modify: `src/wallet/types.ts`
- Modify: `src/wallet/derive.ts`
- Test: `tests/unit/address-watch-wallet.test.ts`

**Interfaces:**
- Consumes: `parseWalletSecret` → `{ kind: "address", value }`; `bitcoinjs-lib` `address.toOutputScript` / `fromBech32` / `fromBase58Check`
- Produces: `WatchWalletKind = "bip84" | "wif" | "address"`; `deriveWatchWallet(address)` → `kind: "address"`, one `WatchAddress` with `path: "address/0"`, `change: false`, `scriptPubKey`, `scriptType`

ScriptType labels (scriptPubKey is source of truth):

| Form | `scriptType` |
|------|----------------|
| `1…` | `p2pkh` |
| `3…` | `p2sh-p2wpkh` (P2SH bucket only; redeem unknown) |
| `bc1q…` v0 | `p2wpkh` |
| `bc1p…` v1 | `p2tr` |

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/address-watch-wallet.test.ts`:

```typescript
import { address as btcAddress } from "bitcoinjs-lib";
import { bytesToHex } from "bip158";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

describe("deriveWatchWallet address", () => {
  test("native segwit → one p2wpkh script matching toOutputScript", () => {
    const w = deriveWatchWallet(ADDR_BECH32);
    expect(w.kind).toBe("address");
    expect(w.secret).toBe(ADDR_BECH32);
    expect(w.addresses).toHaveLength(1);
    expect(w.scripts).toHaveLength(1);
    const a = w.addresses[0]!;
    expect(a.address).toBe(ADDR_BECH32);
    expect(a.path).toBe("address/0");
    expect(a.change).toBe(false);
    expect(a.index).toBe(0);
    expect(a.scriptType).toBe("p2wpkh");
    expect(bytesToHex(a.scriptPubKey)).toBe(
      Buffer.from(btcAddress.toOutputScript(ADDR_BECH32)).toString("hex"),
    );
  });

  test("legacy / nested / taproot labels and script bytes", () => {
    expect(deriveWatchWallet(ADDR_LEGACY).addresses[0]?.scriptType).toBe(
      "p2pkh",
    );
    expect(deriveWatchWallet(ADDR_P2SH).addresses[0]?.scriptType).toBe(
      "p2sh-p2wpkh",
    );
    expect(deriveWatchWallet(ADDR_TAPROOT).addresses[0]?.scriptType).toBe(
      "p2tr",
    );
  });

  test("gaps argument ignored", () => {
    const a = deriveWatchWallet(ADDR_BECH32, 1);
    const b = deriveWatchWallet(ADDR_BECH32, {
      external: 500,
      internal: 500,
    });
    expect(a.addresses).toHaveLength(1);
    expect(b.addresses).toHaveLength(1);
    expect(bytesToHex(a.scripts[0]!)).toBe(bytesToHex(b.scripts[0]!));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/address-watch-wallet.test.ts`

Expected: FAIL — derive treats address as mnemonic / throws.

- [ ] **Step 3: Minimal implementation**

1. In `src/wallet/types.ts`:

```typescript
export type WatchWalletKind = "bip84" | "wif" | "address";
```

2. In `src/wallet/derive.ts`, add helpers + branch (import `address as btcAddress` from `bitcoinjs-lib`):

```typescript
function scriptTypeFromAddress(addr: string): AddressScriptType {
  const lower = addr.toLowerCase();
  if (lower.startsWith("bc1")) {
    const decoded = btcAddress.fromBech32(addr);
    if (decoded.version === 1) return "p2tr";
    return "p2wpkh";
  }
  const { version } = btcAddress.fromBase58Check(addr);
  if (version === 0x00) return "p2pkh";
  if (version === 0x05) return "p2sh-p2wpkh";
  throw new Error("unsupported address version");
}

function deriveAddressWatchWallet(address: string): WatchWallet {
  const scriptPubKey = new Uint8Array(btcAddress.toOutputScript(address));
  const scriptType = scriptTypeFromAddress(address);
  const watchAddr: WatchAddress = {
    path: "address/0",
    index: 0,
    change: false,
    address,
    scriptPubKey,
    scriptType,
  };
  return {
    kind: "address",
    secret: address,
    addresses: [watchAddr],
    scripts: [scriptPubKey],
  };
}
```

In `deriveWatchWallet`:

```typescript
  if (parsed.kind === "wif") {
    return deriveWifWatchWallet(parsed.value);
  }
  if (parsed.kind === "address") {
    return deriveAddressWatchWallet(parsed.value);
  }
  return deriveBip84WatchWallet(
    parsed.value,
    parsed.kind,
    normalizeGaps(gaps),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/address-watch-wallet.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/types.ts src/wallet/derive.ts tests/unit/address-watch-wallet.test.ts
git commit -m "$(cat <<'EOF'
feat: derive fixed one-script watch wallet from address.

EOF
)"
```

---

### Task 3: Receive, change, and gap no-op

**Files:**
- Modify: `src/tui/receive-address-store.ts`
- Modify: `src/tui/send-context.ts`
- Modify: `src/modules/parse-blocks.ts`
- Test: `tests/unit/address-watch-wallet.test.ts`
- Test: `tests/unit/send-context.test.ts` (append one case)

**Interfaces:**
- Consumes: `WatchWallet.kind === "address"`; sole `addresses[0]`
- Produces: receive snapshot address = watched; `buildActiveSendTx` change = watched; `maybeGrowWatch` returns early for `"address"`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/address-watch-wallet.test.ts`:

```typescript
import { createSqliteDatabase } from "../../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../../src/modules/parse-blocks.ts";
import { createMessageBus } from "../../src/bus/message-bus.ts";
import { createReceiveAddressStore } from "../../src/tui/receive-address-store.ts";
import { saveWalletSecret } from "../../src/wallet/secret.ts";
import { createWallet } from "../../src/wallet/wallet.ts";
import { config } from "../../src/config.ts";

describe("address wallet receive + gaps", () => {
  test("receive store returns the sole watched address", () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ADDR_BECH32);
    const wallet = createWallet(db);
    const store = createReceiveAddressStore();
    store.refresh(db, wallet);
    expect(store.get().address).toBe(ADDR_BECH32);
    db.close();
  });

  test("parse-blocks does not grow gaps for address wallets", async () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ADDR_BECH32);
    const bus = createMessageBus();
    const wallet = createWallet(db);
    const before = wallet.gaps();
    const mod = createParseBlocksModule(
      { bus, db },
      { wallet, idleDelayMs: 50, loopGapMs: 0 },
    );
    await mod.start();
    // Force a parse cycle path that would call maybeGrowWatch after txs;
    // easiest: call stop after start — gaps must remain initial and scripts=1.
    expect(wallet.snapshot().kind).toBe("address");
    expect(wallet.scripts()).toHaveLength(1);
    expect(wallet.gaps()).toEqual(before);
    expect(wallet.gaps()).toEqual({
      external: config.initialWatchCount,
      internal: config.initialWatchCount,
    });
    await mod.stop();
    db.close();
  });
});
```

In `tests/unit/send-context.test.ts`, append:

```typescript
describe("buildActiveSendTx address change", () => {
  test("change goes to the watched address for address wallets", () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ADDR_BECH32); // import constant or inline bc1q3rl0...
    const wallet = createWallet(db);
    setActiveSendContext(db, wallet);
    const watch = wallet.snapshot();
    const script = watch.scripts[0]!;

    const result = buildActiveSendTx({
      utxos: [
        {
          txid: "11".repeat(32),
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: script,
        },
      ],
      toAddress: DEST, // existing DEST_LEGACY in file or "1GX36..."
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
    });

    expect(result.kind).toBe("psbt");
    if (result.kind !== "psbt") throw new Error("unreachable");
    expect(result.changeSats).toBeGreaterThan(0n);
    const { Transaction } = require("@scure/btc-signer");
    const { hex } = require("@scure/base");
    const tx = Transaction.fromPSBT(hex.decode(result.psbtHex));
    // one output to DEST, one change to ADDR_BECH32
    const outs = [tx.getOutputAddress(0), tx.getOutputAddress(1)];
    expect(outs).toContain(ADDR_BECH32);
    db.close();
  });
});
```

Use proper ESM imports (same style as the existing file) — do not use `require`. This test also needs Task 4’s `buildSend` address support to fully pass; if it fails only inside PSBT build, keep the change-address assertion by checking that `buildActiveSendTx` selects change correctly — prefer implementing Task 3 receive/gaps first, and put the send-context PSBT assertion in Task 4 if buildDraftTx is not ready.

**Preferred split:** In Task 3, only add a unit-level assertion that does not call full PSBT if blocked — e.g. extract change selection is hard without export. Instead:

Task 3 send-context change: implement the branch now; add the full `buildActiveSendTx` test in Task 4.

For Task 3 tests, keep receive store + gap no-op only.

- [ ] **Step 2: Run receive/gap tests to verify fail**

Run: `bun test tests/unit/address-watch-wallet.test.ts`

Expected: FAIL — receive store uses BIP84 unused-external path → `null` or wrong; or passes receive if index 0 unused — for address wallet BIP84 path looks at `addresses` with `!change` and may accidentally return the sole address. **Strengthen the receive test:** after implementing BIP84 path on an address wallet, `usedWatchIndexes` + `firstUnusedExternalAddress` may still return index 0. That is OK functionally for receive, but still wire an explicit `kind === "address"` branch for clarity and to avoid future HD assumptions.

If the receive test would pass without changes, change the test to assert `wallet.snapshot().kind === "address"` via store path and still implement the explicit branch. Gap test: assert `maybeGrowWatch` early-return by checking `snap.kind` branch exists — the module test above is smoke-level.

- [ ] **Step 3: Minimal implementation**

`src/tui/receive-address-store.ts`:

```typescript
  if (watch.kind === "wif") {
    const addr = preferredWifReceiveAddress(watch, db.transactions.list());
    return { address: addr.address };
  }
  if (watch.kind === "address") {
    return { address: watch.addresses[0]?.address ?? null };
  }
```

`src/tui/send-context.ts`:

```typescript
  } else if (watch.kind === "wif") {
    changeAddress = preferredWifReceiveAddress(
      watch,
      db.transactions.list(),
    ).address;
  } else if (watch.kind === "address") {
    const addr = watch.addresses[0];
    if (!addr) throw new Error("address wallet missing watched address");
    changeAddress = addr.address;
  } else {
```

`src/modules/parse-blocks.ts`:

```typescript
    // Fixed watch sets (WIF four scripts / single address) — never grow HD gaps.
    if (snap.kind === "wif" || snap.kind === "address") return;
```

Update the send-context file comment to mention address wallets.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/address-watch-wallet.test.ts`

Expected: PASS for receive + gaps describes.

- [ ] **Step 5: Commit**

```bash
git add src/tui/receive-address-store.ts src/tui/send-context.ts src/modules/parse-blocks.ts tests/unit/address-watch-wallet.test.ts
git commit -m "$(cat <<'EOF'
feat: wire address wallet receive, change, and gap freeze.

EOF
)"
```

---

### Task 4: Unsigned PSBT send for address wallets

**Files:**
- Modify: `src/wallet/build-send-tx.ts`
- Test: `tests/unit/address-watch-wallet.test.ts`
- Test: `tests/unit/send-context.test.ts` (address change + PSBT)

**Interfaces:**
- Consumes: `parseWalletSecret` → `"address"`; `WatchAddress.scriptType`; taproot x-only from `btcAddress.fromBech32`
- Produces: `buildSend({ secret: address, ... })` → `{ kind: "psbt", ... }`; change output to watched address; taproot inputs use `p2tr(xOnly)`; other types use script + `witnessUtxo` / `nonWitnessUtxo` only (no `bip32Derivation`)

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/address-watch-wallet.test.ts`:

```typescript
import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { buildSend, buildSignedSendTx } from "../../src/wallet/build-send-tx.ts";

const DEST = "1GX36PGBUrF8XahZEGQqHqnJGW2vCZteoB";

describe("buildSend address watch-only", () => {
  test("returns unsigned PSBT; change to same address; refuses signed builder", () => {
    const wallet = deriveWatchWallet(ADDR_BECH32);
    const utxo = {
      txid: "11".repeat(32),
      vout: 0,
      valueSats: 100_000n,
      scriptPubKey: wallet.scripts[0]!,
    };
    const result = buildSend({
      secret: ADDR_BECH32,
      wallet,
      utxos: [utxo],
      toAddress: DEST,
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
      changeAddress: ADDR_BECH32,
    });
    expect(result.kind).toBe("psbt");
    if (result.kind !== "psbt") throw new Error("unreachable");
    expect(result.psbtHex.startsWith("70736274ff")).toBe(true);
    expect(result.changeSats).toBeGreaterThan(0n);

    const tx = Transaction.fromPSBT(hex.decode(result.psbtHex));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
    const outAddrs = [tx.getOutputAddress(0), tx.getOutputAddress(1)];
    expect(outAddrs).toContain(DEST);
    expect(outAddrs).toContain(ADDR_BECH32);

    expect(() =>
      buildSignedSendTx({
        secret: ADDR_BECH32,
        wallet,
        utxos: [utxo],
        toAddress: DEST,
        amountSats: 50_000n,
        feeRateSatPerVb: 1,
        changeAddress: ADDR_BECH32,
      }),
    ).toThrow(/mnemonic|WIF|sign/i);
  });

  test("send-max has single output and zero changeSats", () => {
    const wallet = deriveWatchWallet(ADDR_BECH32);
    const utxo = {
      txid: "22".repeat(32),
      vout: 0,
      valueSats: 100_000n,
      scriptPubKey: wallet.scripts[0]!,
    };
    const result = buildSend({
      secret: ADDR_BECH32,
      wallet,
      utxos: [utxo],
      toAddress: DEST,
      amountSats: "max",
      feeRateSatPerVb: 1,
      changeAddress: ADDR_BECH32,
    });
    expect(result.kind).toBe("psbt");
    if (result.kind !== "psbt") throw new Error("unreachable");
    expect(result.changeSats).toBe(0n);
    const tx = Transaction.fromPSBT(hex.decode(result.psbtHex));
    expect(tx.outputsLength).toBe(1);
    expect(tx.getOutputAddress(0)).toBe(DEST);
  });

  test("taproot address builds PSBT using p2tr from address key", () => {
    const wallet = deriveWatchWallet(ADDR_TAPROOT);
    const result = buildSend({
      secret: ADDR_TAPROOT,
      wallet,
      utxos: [
        {
          txid: "33".repeat(32),
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: wallet.scripts[0]!,
        },
      ],
      toAddress: DEST,
      amountSats: 50_000n,
      feeRateSatPerVb: 1,
      changeAddress: ADDR_TAPROOT,
    });
    expect(result.kind).toBe("psbt");
  });
});
```

Also add the `buildActiveSendTx` address change test from Task 3 notes into `tests/unit/send-context.test.ts` (ESM imports).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/address-watch-wallet.test.ts`

Expected: FAIL inside `accountKey` / `buildDraftTx` (address not handled).

- [ ] **Step 3: Minimal implementation**

In `src/wallet/build-send-tx.ts`:

1. Import `address as btcAddress` from `bitcoinjs-lib` if not already.

2. Extend `AccountKey`:

```typescript
  | { kind: "address" };
```

3. In `accountKey`:

```typescript
  if (parsed.kind === "address") {
    return { kind: "address" };
  }
```

(Place after WIF, before/after mnemonic as needed — any order after parse is fine.)

4. In `buildDraftTx` input mapping, before the BIP84 HD branch:

```typescript
    if (account.kind === "address") {
      const scriptType = scriptTypeOf(addr);
      if (scriptType === "p2pkh" && !u.nonWitnessUtxo) {
        throw new Error(
          "legacy p2pkh input requires nonWitnessUtxo (previous transaction)",
        );
      }
      if (scriptType === "p2tr") {
        const decoded = btcAddress.fromBech32(addr.address);
        const spend = p2tr(decoded.data);
        return {
          ...spend,
          txid: hex.decode(u.txid),
          index: u.vout,
          witnessUtxo: {
            script: u.scriptPubKey,
            amount: u.valueSats,
          },
        };
      }
      return {
        txid: hex.decode(u.txid),
        index: u.vout,
        witnessUtxo: {
          script: u.scriptPubKey,
          amount: u.valueSats,
        },
        ...(u.nonWitnessUtxo ? { nonWitnessUtxo: u.nonWitnessUtxo } : {}),
      };
    }
```

5. In `buildSignedSendTx`, treat address like zpub:

```typescript
  if (account.kind === "zpub" || account.kind === "address") {
    throw new Error("signing requires a mnemonic or WIF wallet secret");
  }
```

6. `buildSend` already routes non-mnemonic/wif to `buildUnsignedSendPsbt` — no change required if `"address"` is not in the signed branch. Verify:

```typescript
  if (parsed.kind === "mnemonic" || parsed.kind === "wif") {
    return buildSignedSendTx(params);
  }
  return buildUnsignedSendPsbt(params);
```

Update the file comment that says “Works with mnemonic, zpub, or WIF” to include address.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
bun test tests/unit/address-watch-wallet.test.ts tests/unit/send-context.test.ts tests/unit/build-send-tx.test.ts tests/unit/wif-wallet.test.ts
```

Expected: PASS. If script-only inputs fail inside `selectUTXO` for p2wpkh, fix by passing a minimal payment-compatible object — e.g. include `script: u.scriptPubKey` on the input if scure requires it (inspect error; adjust minimally).

- [ ] **Step 5: Commit**

```bash
git add src/wallet/build-send-tx.ts tests/unit/address-watch-wallet.test.ts tests/unit/send-context.test.ts
git commit -m "$(cat <<'EOF'
feat: build unsigned PSBT sends for address watch wallets.

EOF
)"
```

---

### Task 5: Onboarding copy + full regression

**Files:**
- Modify: `src/tui/OnboardingApp.tsx`
- Test: none required for copy-only (manual string check in commit); run full unit suite

- [ ] **Step 1: Update onboarding strings**

In `src/tui/OnboardingApp.tsx` import step:

- Prompt: `Enter BIP39 seed, account zpub, WIF private key, or address`
- Placeholder: `seed words, zpub, WIF, or address…`

- [ ] **Step 2: Run full unit tests + typecheck**

```bash
bun test tests/unit
bun run typecheck
```

Expected: all PASS; `tsc --noEmit` clean.

- [ ] **Step 3: Commit**

```bash
git add src/tui/OnboardingApp.tsx
git commit -m "$(cat <<'EOF'
docs: mention address import on onboarding screen.

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| Secret kind `"address"` + detection order | 1 |
| Derive one script + scriptType labels | 2 |
| Gaps ignored / `maybeGrowWatch` no-op | 2, 3 |
| Receive = sole address | 3 |
| Change = same address | 3, 4 |
| Unsigned PSBT like zpub | 4 |
| Taproot p2tr from address; others script-only | 4 |
| Onboarding copy | 5 |
| Tests listed in spec | 1–4 |
| Out of scope left out | — |

---

## Self-review notes

- No TBD placeholders; nested P2SH redeemScript explicitly out of scope (script-hash PSBT only).
- `WatchWalletKind` / `WalletSecretKind` both gain `"address"` consistently.
- `buildSend` routing relies on excluding address from the mnemonic/wif signed branch — Task 4 verifies.
