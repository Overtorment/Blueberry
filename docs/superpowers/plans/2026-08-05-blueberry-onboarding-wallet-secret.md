# blueberry Onboarding + wallet_secret Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist BIP39 mnemonic or account-level mainnet `zpub` in `key_value`, gate app start behind a dedicated onboarding TUI when missing, then soft-re-exec into a normal cold start.

**Architecture:** `main` opens SQLite and checks `wallet_secret`. Missing → only `OnboardingApp` (BLUEBERRY + input). On valid submit → save → destroy renderer → `reexecSelf()` so the next process runs the existing bus/modules/main TUI path. `deriveWatchWallet` accepts mnemonic or `zpub` (SLIP-132 versions, account depth 3) and derives BIP84 receive/change `p2wpkh` the same way.

**Tech Stack:** Bun, TypeScript, React 19 + OpenTUI, `bun:sqlite` `key_value`, `@scure/bip32` / `@scure/bip39` / `@scure/btc-signer`. No new npm dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-05-blueberry-onboarding-wallet-secret-design.md`.
- KV key: `wallet_secret` (plaintext string; auto-detect mnemonic vs `zpub`).
- Remove `config.seed` entirely; modules use `options.seed ?? db.keyValue.get("wallet_secret")`.
- Keep module option name `seed` (string may be mnemonic or zpub) for test overrides.
- Mainnet only: accept `zpub`, reject `xpub` / `vpub` / other prefixes.
- Zpub = account-level BIP84 (`depth === 3`); derive `{0|1}/i` → `p2wpkh`.
- Soft re-exec after save (cold-start parity); no in-process module start from onboarding.
- No encryption; no change-wallet UI; no auto-migration of the old hardcoded phrase.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).

## File structure

| Path | Responsibility |
|------|----------------|
| `src/wallet/secret.ts` | `WALLET_SECRET_KEY`, parse/validate, load/save/has helpers |
| `src/wallet/derive.ts` | `deriveWatchWallet(secret, gaps)` for mnemonic + zpub |
| `src/wallet/types.ts` | Rename `mnemonic` → `secret` on `WatchWallet` |
| `src/config.ts` | Remove `seed` |
| `src/modules/parse-blocks.ts` | Load secret from KV when `options.seed` unset |
| `src/modules/filters-matching.ts` | Same |
| `src/boot/reexec.ts` | `reexecSelf()` process replace/spawn helper |
| `src/tui/OnboardingApp.tsx` | BLUEBERRY + input panel; calls save callback |
| `src/main.tsx` | Gate: onboarding vs full app; wire re-exec after save |
| `tests/wallet-secret.test.ts` | Parse/validate + KV load/save/has |
| `tests/wallet-derive.test.ts` | Extend with zpub parity / reject cases |

---

### Task 1: Wallet secret parse / load / save

**Files:**
- Create: `src/wallet/secret.ts`
- Create: `tests/wallet-secret.test.ts`

**Interfaces:**
- Consumes: `KeyValueRepository` shape `{ get(key): string | null; set(key, value): void }`; `@scure/bip39` `validateMnemonic`; `@scure/bip32` `HDKey`
- Produces:
  - `WALLET_SECRET_KEY = "wallet_secret"`
  - `BIP84_ZPUB_VERSIONS = { private: 0x04b2430c, public: 0x04b24746 }`
  - `type WalletSecretKind = "mnemonic" | "zpub"`
  - `type ParsedWalletSecret = { kind: WalletSecretKind; value: string }`
  - `parseWalletSecret(raw: string): ParsedWalletSecret` — throws `Error` with readable message on invalid
  - `hasWalletSecret(db): boolean`
  - `loadWalletSecret(db): string` — throws if missing/empty
  - `saveWalletSecret(db, raw: string): ParsedWalletSecret` — parse then `set`

- [ ] **Step 1: Write the failing tests**

Create `tests/wallet-secret.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import {
  BIP84_ZPUB_VERSIONS,
  WALLET_SECRET_KEY,
  hasWalletSecret,
  loadWalletSecret,
  parseWalletSecret,
  saveWalletSecret,
} from "../src/wallet/secret.ts";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function abandonAccountZpub(): string {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON), BIP84_ZPUB_VERSIONS)
    .derive("m/84'/0'/0'")
    .publicExtendedKey;
}

describe("parseWalletSecret", () => {
  test("accepts abandon mnemonic", () => {
    const p = parseWalletSecret(`  ${ABANDON}  `);
    expect(p).toEqual({ kind: "mnemonic", value: ABANDON });
  });

  test("rejects invalid mnemonic", () => {
    expect(() => parseWalletSecret("not a real mnemonic phrase at all")).toThrow();
  });

  test("accepts account zpub", () => {
    const zpub = abandonAccountZpub();
    expect(zpub.startsWith("zpub")).toBe(true);
    const p = parseWalletSecret(zpub);
    expect(p).toEqual({ kind: "zpub", value: zpub });
  });

  test("rejects xpub", () => {
    const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON))
      .derive("m/84'/0'/0'")
      .publicExtendedKey;
    expect(() => parseWalletSecret(xpub)).toThrow();
  });

  test("rejects non-account zpub depth", () => {
    const masterZpub = HDKey.fromMasterSeed(
      mnemonicToSeedSync(ABANDON),
      BIP84_ZPUB_VERSIONS,
    ).publicExtendedKey;
    expect(() => parseWalletSecret(masterZpub)).toThrow();
  });
});

describe("wallet_secret KV", () => {
  test("has/load/save round-trip", () => {
    const db = createSqliteDatabase(":memory:");
    expect(hasWalletSecret(db)).toBe(false);
    expect(() => loadWalletSecret(db)).toThrow();
    saveWalletSecret(db, ABANDON);
    expect(hasWalletSecret(db)).toBe(true);
    expect(loadWalletSecret(db)).toBe(ABANDON);
    expect(db.keyValue.get(WALLET_SECRET_KEY)).toBe(ABANDON);
    db.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/wallet-secret.test.ts`

Expected: FAIL (module not found / exports missing).

- [ ] **Step 3: Implement `src/wallet/secret.ts`**

```ts
import { HDKey } from "@scure/bip32";
import { validateMnemonic } from "@scure/bip39";

/** SLIP-0132 mainnet BIP84 (zpub/zprv). */
export const BIP84_ZPUB_VERSIONS = {
  private: 0x04b2430c,
  public: 0x04b24746,
} as const;

export const WALLET_SECRET_KEY = "wallet_secret";

/** BIP32 depth of m/84'/0'/0' */
const ACCOUNT_DEPTH = 3;

export type WalletSecretKind = "mnemonic" | "zpub";

export type ParsedWalletSecret = {
  kind: WalletSecretKind;
  value: string;
};

type Kv = {
  keyValue: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
};

export function parseWalletSecret(raw: string): ParsedWalletSecret {
  const value = raw.trim();
  if (!value) throw new Error("wallet secret is empty");

  if (value.startsWith("zpub")) {
    let key: HDKey;
    try {
      key = HDKey.fromExtendedKey(value, BIP84_ZPUB_VERSIONS);
    } catch {
      throw new Error("invalid zpub");
    }
    if (key.depth !== ACCOUNT_DEPTH) {
      throw new Error("zpub must be account-level (m/84'/0'/0')");
    }
    if (!key.publicKey) throw new Error("invalid zpub");
    return { kind: "zpub", value };
  }

  if (
    value.startsWith("xpub") ||
    value.startsWith("ypub") ||
    value.startsWith("vpub") ||
    value.startsWith("tpub")
  ) {
    throw new Error("only mainnet account zpub is supported");
  }

  if (!validateMnemonic(value)) {
    throw new Error("invalid BIP39 mnemonic");
  }
  return { kind: "mnemonic", value };
}

export function hasWalletSecret(db: Kv): boolean {
  const v = db.keyValue.get(WALLET_SECRET_KEY);
  return v !== null && v.trim().length > 0;
}

export function loadWalletSecret(db: Kv): string {
  const v = db.keyValue.get(WALLET_SECRET_KEY);
  if (v === null || !v.trim()) throw new Error("wallet_secret missing");
  return v.trim();
}

export function saveWalletSecret(db: Kv, raw: string): ParsedWalletSecret {
  const parsed = parseWalletSecret(raw);
  db.keyValue.set(WALLET_SECRET_KEY, parsed.value);
  return parsed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/wallet-secret.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/wallet/secret.ts tests/wallet-secret.test.ts
git commit -m "Add wallet_secret parse and key_value helpers."
```

---

### Task 2: Derive watch wallet from mnemonic or zpub

**Files:**
- Modify: `src/wallet/types.ts`
- Modify: `src/wallet/derive.ts`
- Modify: `tests/wallet-derive.test.ts`

**Interfaces:**
- Consumes: `parseWalletSecret`, `BIP84_ZPUB_VERSIONS` from `secret.ts`; existing gap helpers
- Produces: `deriveWatchWallet(secret: string, gaps?: number | WatchGaps): WatchWallet` where `WatchWallet.secret` is the trimmed stored string; zpub path yields same scripts as mnemonic for abandon fixture

- [ ] **Step 1: Write the failing zpub parity tests**

Append to `tests/wallet-derive.test.ts`:

```ts
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { BIP84_ZPUB_VERSIONS } from "../src/wallet/secret.ts";

// inside describe("BIP84 derive", ...):

  test("account zpub matches mnemonic scripts", () => {
    const fromMnemonic = deriveWatchWallet(ABANDON_MNEMONIC, {
      external: 3,
      internal: 2,
    });
    const zpub = HDKey.fromMasterSeed(
      mnemonicToSeedSync(ABANDON_MNEMONIC),
      BIP84_ZPUB_VERSIONS,
    )
      .derive("m/84'/0'/0'")
      .publicExtendedKey;
    const fromZpub = deriveWatchWallet(zpub, { external: 3, internal: 2 });
    expect(fromZpub.secret).toBe(zpub);
    expect(fromZpub.addresses.map((a) => a.address)).toEqual(
      fromMnemonic.addresses.map((a) => a.address),
    );
    expect(fromZpub.addresses.map((a) => a.path)).toEqual(
      fromMnemonic.addresses.map((a) => a.path),
    );
  });

  test("rejects xpub via derive", () => {
    const xpub = HDKey.fromMasterSeed(mnemonicToSeedSync(ABANDON_MNEMONIC))
      .derive("m/84'/0'/0'")
      .publicExtendedKey;
    expect(() => deriveWatchWallet(xpub, 1)).toThrow();
  });
```

Also update any assertion that read `wallet.mnemonic` to `wallet.secret` if present (currently none in repo; the abandon test should still pass and may assert `wallet.secret === ABANDON_MNEMONIC`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/wallet-derive.test.ts`

Expected: FAIL (zpub not supported / `secret` field missing).

- [ ] **Step 3: Update types + derive**

`src/wallet/types.ts` — rename field:

```ts
export type WatchWallet = {
  secret: string;
  addresses: WatchAddress[];
  scripts: Uint8Array[];
};
```

`src/wallet/derive.ts` — replace derive body:

```ts
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { p2wpkh } from "@scure/btc-signer";
import type { WatchAddress, WatchWallet } from "./types.ts";
import { BIP84_ZPUB_VERSIONS, parseWalletSecret } from "./secret.ts";

export const BIP84_ACCOUNT_PATH = "m/84'/0'/0'";
// ... keep GAP_LIMIT, ADDRESS_GAP, WATCH_*_KEY, WatchGaps, normalizeGaps ...

export function deriveWatchWallet(
  secret: string,
  gaps?: number | WatchGaps,
): WatchWallet {
  const { external, internal } = normalizeGaps(gaps);
  const parsed = parseWalletSecret(secret);

  let account: HDKey;
  if (parsed.kind === "mnemonic") {
    const seed = mnemonicToSeedSync(parsed.value);
    const root = HDKey.fromMasterSeed(seed);
    account = root.derive(BIP84_ACCOUNT_PATH);
  } else {
    account = HDKey.fromExtendedKey(parsed.value, BIP84_ZPUB_VERSIONS);
  }

  const addresses: WatchAddress[] = [];
  const chains: Array<{ change: boolean; count: number }> = [
    { change: false, count: external },
    { change: true, count: internal },
  ];
  for (const { change, count } of chains) {
    const chain = change ? 1 : 0;
    for (let index = 0; index < count; index++) {
      const path = `${BIP84_ACCOUNT_PATH}/${chain}/${index}`;
      const child = account.derive(`${chain}/${index}`);
      if (!child.publicKey) throw new Error(`missing public key at ${path}`);
      const { address, script } = p2wpkh(child.publicKey);
      if (!address) throw new Error(`failed to encode address at ${path}`);
      addresses.push({
        path,
        index,
        change,
        address,
        scriptPubKey: new Uint8Array(script),
      });
    }
  }
  return {
    secret: parsed.value,
    addresses,
    scripts: addresses.map((a) => a.scriptPubKey),
  };
}
```

- [ ] **Step 4: Run derive + secret tests**

Run: `bun test tests/wallet-derive.test.ts tests/wallet-secret.test.ts`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/wallet/types.ts src/wallet/derive.ts tests/wallet-derive.test.ts
git commit -m "Derive BIP84 watch scripts from mnemonic or account zpub."
```

---

### Task 3: Remove config.seed; modules read `wallet_secret`

**Files:**
- Modify: `src/config.ts` (delete `seed` property + comment block)
- Modify: `src/modules/parse-blocks.ts`
- Modify: `src/modules/filters-matching.ts`

**Interfaces:**
- Consumes: `loadWalletSecret` / `hasWalletSecret` pattern — use `options.seed ??` KV get
- Produces: modules throw clear error if neither override nor KV secret present; existing tests that pass `options.seed` keep working

- [ ] **Step 1: Write a failing module-wiring test**

Create `tests/wallet-secret-modules.test.ts` (or extend an existing parse/matching test file with a focused case):

```ts
import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../src/bus/message-bus.ts";
import { createSqliteDatabase } from "../src/db/sqlite-database.ts";
import { createParseBlocksModule } from "../src/modules/parse-blocks.ts";
import { saveWalletSecret } from "../src/wallet/secret.ts";

const ABANDON =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("parse-blocks secret source", () => {
  test("starts from wallet_secret when options.seed omitted", async () => {
    const db = createSqliteDatabase(":memory:");
    saveWalletSecret(db, ABANDON);
    const bus = createMessageBus();
    const mod = createParseBlocksModule({ bus, db }, { idleDelayMs: 50, blockGapMs: 0 });
    await mod.start();
    await mod.stop();
    db.close();
  });

  test("errors when secret missing and no options.seed", async () => {
    const db = createSqliteDatabase(":memory:");
    const bus = createMessageBus();
    const mod = createParseBlocksModule({ bus, db }, { idleDelayMs: 50, blockGapMs: 0 });
    let detail = "";
    bus.on("module:status", (e) => {
      if (e.module === mod.name && e.status === "error") detail = e.detail ?? "";
    });
    // start catches and emits error in main — here call start and expect throw OR error status.
    // Prefer: start() throws so createParseBlocksModule resolves secret lazily in start().
    await expect(mod.start()).rejects.toThrow(/wallet_secret/);
    db.close();
  });
});
```

Note: today `seed` is captured at module construction from `config.seed`. Change to resolve inside `start()` (or at construction from `options.seed ?? db.keyValue.get(...)` with throw if null). Prefer resolve at construction:

```ts
const seed =
  options.seed ??
  ctx.db.keyValue.get(WALLET_SECRET_KEY)?.trim() ??
  "";
if (!seed) {
  // defer throw to start() so factory stays sync-safe, OR throw in start before work
}
```

Spec: throw if absent at start. Implement: compute `const seed = options.seed ?? ctx.db.keyValue.get(WALLET_SECRET_KEY)?.trim()` in factory; in `start()`, if `!seed` throw `new Error("wallet_secret missing")`.

- [ ] **Step 2: Run test to verify fail**

Run: `bun test tests/wallet-secret-modules.test.ts`

Expected: FAIL (still uses `config.seed` or does not throw).

- [ ] **Step 3: Wire modules + remove config.seed**

In `src/config.ts`, delete the entire `seed` property and its comment.

In `parse-blocks.ts` and `filters-matching.ts`:

```ts
import { WALLET_SECRET_KEY } from "../wallet/secret.ts";
// remove: import { config } from "../config.ts";  (if unused after)

const seed =
  options.seed ?? ctx.db.keyValue.get(WALLET_SECRET_KEY)?.trim() ?? "";
```

At the top of `start()`:

```ts
if (!seed) throw new Error("wallet_secret missing");
```

Keep using local `seed` for `deriveWatchWallet(seed, …)`.

- [ ] **Step 4: Run module + wallet tests**

Run: `bun test tests/wallet-secret-modules.test.ts tests/wallet-secret.test.ts tests/wallet-derive.test.ts tests/parse-blocks.test.ts tests/parse-blocks-gap.test.ts tests/filters-matching.test.ts`

Expected: PASS (existing tests already pass `options.seed`).

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/config.ts src/modules/parse-blocks.ts src/modules/filters-matching.ts tests/wallet-secret-modules.test.ts
git commit -m "Load watch secret from key_value instead of config."
```

---

### Task 4: Onboarding TUI

**Files:**
- Create: `src/tui/OnboardingApp.tsx`

**Interfaces:**
- Consumes: `BlueberryArt`, `Panel` / `THEME`, OpenTUI `<input onSubmit>`, `parseWalletSecret` (validate before calling parent)
- Produces: `OnboardingApp({ onSubmit(raw: string): void })` — parent persists + re-exec; component shows inline error on `parseWalletSecret` throw

- [ ] **Step 1: Implement `OnboardingApp`**

No separate React test harness required (logic covered by `parseWalletSecret` / `saveWalletSecret`). Manual check in Task 5.

```tsx
import { useState } from "react";
import { BlueberryArt } from "./components/BlueberryArt.tsx";
import { Panel } from "./chrome.tsx";
import { THEME } from "./theme.ts";
import { parseWalletSecret } from "../wallet/secret.ts";

export type OnboardingAppProps = {
  onSubmit: (raw: string) => void;
};

export function OnboardingApp({ onSubmit }: OnboardingAppProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function submit(raw: string) {
    if (busy) return;
    try {
      parseWalletSecret(raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    setError(null);
    setBusy(true);
    onSubmit(raw);
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={1}
      padding={1}
      backgroundColor={THEME.bg}
    >
      <box width="100%" height={7} flexGrow={0}>
        <BlueberryArt />
      </box>

      <box width="80%" height={8} flexGrow={0}>
        <Panel title="Wallet" state="active" accent="magenta" height="100%">
          <text fg={THEME.fgDim}>Enter BIP39 seed or account zpub</text>
          <input
            focused={!busy}
            value={value}
            placeholder="seed words or zpub…"
            onInput={(v) => {
              setValue(v);
              if (error) setError(null);
            }}
            onSubmit={submit}
          />
          <text fg={error ? THEME.accentMagenta : THEME.fgDim}>
            {error ?? (busy ? "Saving…" : "Press Enter to continue")}
          </text>
        </Panel>
      </box>
    </box>
  );
}
```

Adjust heights/widths if OpenTUI layout clips; keep one composition: art + one input window.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`

Expected: PASS (or only pre-existing errors unrelated to this file).

- [ ] **Step 3: Commit (only if user asked)**

```bash
git add src/tui/OnboardingApp.tsx
git commit -m "Add onboarding TUI for wallet secret entry."
```

---

### Task 5: Main gate + soft re-exec

**Files:**
- Create: `src/boot/reexec.ts`
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `hasWalletSecret`, `saveWalletSecret`, `OnboardingApp`, existing app boot block
- Produces: `reexecSelf(): never` — spawn same runtime + argv with inherited stdio, then `process.reallyExit` with child code; on spawn failure write stderr and exit ≠ 0

- [ ] **Step 1: Implement `reexecSelf`**

Create `src/boot/reexec.ts`:

```ts
/**
 * Soft-re-exec this process so boot matches a cold start.
 * Parent waits for the child (stdio inherited) then exits with the child code.
 */
export function reexecSelf(): never {
  const cmd = process.execPath;
  const args = process.argv.slice(1);
  const result = Bun.spawnSync([cmd, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.error) {
    console.error("failed to re-exec:", result.error.message);
    process.reallyExit(1);
  }
  process.reallyExit(result.exitCode ?? 1);
}
```

- [ ] **Step 2: Restructure `main.tsx`**

Refactor so the top-level flow is:

```ts
mkdirSync("./data", { recursive: true });
const db = createSqliteDatabase("./data/blueberry.sqlite");

if (!hasWalletSecret(db)) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
  });
  const root = createRoot(renderer);
  root.render(
    <OnboardingApp
      onSubmit={(raw) => {
        try {
          saveWalletSecret(db, raw);
        } catch (err) {
          // OnboardingApp already validates; save failures should be rare.
          console.error(err);
          process.reallyExit(1);
        }
        try {
          root.unmount?.();
        } catch {
          /* ignore */
        }
        try {
          renderer.destroy();
        } catch {
          /* ignore */
        }
        try {
          db.close();
        } catch {
          /* ignore */
        }
        reexecSelf();
      }}
    />,
  );

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || key.name === "Q") process.reallyExit(0);
  });
  process.once("SIGINT", () => process.reallyExit(0));
  process.once("SIGTERM", () => process.reallyExit(0));
  // Do not start modules / main App.
} else {
  // EXISTING boot body: bus, stores, modules, App, shutdown — unchanged,
  // except db already opened above (do not open twice).
}
```

Details:

- Move `const db = createSqliteDatabase(...)` before the branch; in the app branch reuse that `db`.
- Do **not** create bus/modules/stores in the onboarding branch.
- After successful save, always destroy renderer + close db before `reexecSelf()`.
- If `saveWalletSecret` throws (e.g. disk), prefer surfacing via re-throw into onboarding — simplest acceptable approach for this slice: `console.error` + `reallyExit(1)` as above; optional improvement: pass `onError` into `OnboardingApp` (not required if validate already ran).

Extract the current post-DB boot into a clear `async function startApp(db: Database)` to keep `main.tsx` readable — same behavior as today’s sequential module start.

- [ ] **Step 3: Manual verification**

1. Backup/move `data/blueberry.sqlite` if you care about local state, or use a temp data dir.
2. Ensure no `wallet_secret` row (fresh DB or `DELETE FROM key_value WHERE key = 'wallet_secret';`).
3. Run: `bun start`
4. Expect: BLUEBERRY + input panel only; no sync tiles.
5. Paste invalid text → Enter → inline error.
6. Paste abandon mnemonic → Enter → process restarts into main dashboard.
7. Quit and run `bun start` again → skips onboarding (secret present).
8. Optional: delete secret, restart, paste abandon account `zpub` (from Task 1 helper) → main app boots.

- [ ] **Step 4: Full automated suite**

Run: `bun test`

Expected: PASS

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/boot/reexec.ts src/main.tsx src/tui/OnboardingApp.tsx
git commit -m "Gate app start behind wallet_secret onboarding TUI."
```

---

## Spec coverage checklist

| Spec requirement | Task |
|------------------|------|
| `wallet_secret` in `key_value` | 1 |
| Remove `config.seed` | 3 |
| Parse mnemonic / zpub; reject xpub/vpub | 1 |
| Account zpub → BIP84 p2wpkh same as seed | 2 |
| Onboarding TUI BLUEBERRY + input | 4 |
| No modules until secret present | 5 |
| Soft re-exec after save | 5 |
| Modules load from KV; `options.seed` override | 3 |
| Immutable / no encryption / mainnet only | constraints (no extra tasks) |
