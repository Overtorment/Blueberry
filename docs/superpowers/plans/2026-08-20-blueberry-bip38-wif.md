# Password-protected WIF (BIP38) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboarding detects a BIP38 `6P…` key, asks for a password, decrypts to a plain WIF, and stores that WIF; uncompressed `5…` WIFs watch one legacy `p2pkh`.

**Architecture:** Detect `6P…` in a small helper, decrypt with npm `bip38.decryptAsync`, then encode a mainnet WIF and reuse `parseWalletSecret` / `saveWalletSecret`. `@scure/btc-signer` `WIF()` is compressed-only, so encode/decode uncompressed keys with `@scure/base` `base58check` (same 0x80 payload BIP38 uses). `kind` stays `"wif"`: four scripts when compressed, one uncompressed `p2pkh` when not.

**Tech Stack:** Bun, TypeScript, npm `bip38@3.1.1`, `@scure/base` base58check, `@scure/btc-signer` `p2pkh`, existing onboarding TUI.

**Spec:** `docs/superpowers/specs/2026-08-20-blueberry-bip38-wif-design.md`

## Global Constraints

- Detect: trimmed secret is 58 characters and starts with `6P` (both BIP38 methods).
- Decrypt with npm `bip38` (`decryptAsync`); official scrypt unless a test passes weaker params.
- Do not use `github:BlueWallet/bip38`.
- KV `wallet_secret` stores the plain WIF only. Never store `6P…` or the password.
- Secret kind stays `"wif"` (no new kind).
- Compressed WIF (`K`/`L`): four scripts; default receive native segwit.
- Uncompressed WIF (`5…`): one uncompressed legacy `p2pkh`; receive and change are that address.
- `parseWalletSecret` stays sync; decrypt is async and only runs in onboarding.
- Mainnet only; reject testnet WIF (`c…` / `9…`).
- Do not implement BIP38 encrypt.

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/wallet/bip38.ts` | `isBip38Key`, `encodeWif`, `decryptBip38ToWif` |
| `src/wallet/secret.ts` | `decodeWif` (compressed flag); reject raw `6P…`; accept `5…` |
| `src/wallet/derive.ts` | One vs four WIF scripts from `compressed` |
| `src/wallet/receive-address.ts` | Fallback when no native address |
| `src/wallet/build-send-tx.ts` | `accountKey` uses compressed flag for the pubkey |
| `src/tui/onboarding-import.ts` | Classify import / unlock BIP38 / masked password input |
| `src/tui/OnboardingApp.tsx` | Password step |
| `tests/unit/bip38.test.ts` | BlueWallet port + detect/parse/onboarding helpers |
| `tests/unit/wif-wallet.test.ts` | Accept `5…`; derive one script; receive fallback; sign |

---

### Task 1: Detect BIP38 and reject it as `wallet_secret`

**Files:**
- Create: `src/wallet/bip38.ts`
- Modify: `src/wallet/secret.ts`
- Test: `tests/unit/bip38.test.ts` (create)

**Interfaces:**
- Consumes: none
- Produces: `isBip38Key(value: string): boolean`; `parseWalletSecret` throws `password-protected WIF requires a password` for a BIP38 string

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/bip38.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isBip38Key } from "../../src/wallet/bip38.ts";
import {
  inspectWalletSecret,
  parseWalletSecret,
} from "../../src/wallet/secret.ts";

/** BlueWallet tests/unit/bip38.test.ts (method 1, weak-scrypt ciphertext). */
const BIP38_FAST =
  "6PRVWUbkzq2VVjRuv58jpwVjTeN46MeNmzUHqUjQptBJUHGcBakduhrUNc";
/** BlueWallet skipped slow vector (EC-multiply). */
const BIP38_SLOW =
  "6PnU5voARjBBykwSddwCdcn6Eu9EcsK24Gs5zWxbJbPZYW7eiYQP8XgKbN";

const WIF_COMPRESSED =
  "L4vn2KxgMLrEVpxjfLwxfjnPPQMnx42DCjZJ2H7nN4mdHDyEUWXd";
const WIF_UNCOMPRESSED =
  "5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR";
const ZPUB =
  "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const ADDR = "1Jq6MksXQVWzrznvZzxkV6oY57oWXD9TXB";

describe("isBip38Key", () => {
  test("is true for 58-character 6P keys", () => {
    expect(isBip38Key(BIP38_FAST)).toBe(true);
    expect(isBip38Key(`  ${BIP38_SLOW}  `)).toBe(true);
  });

  test("is false for WIF, zpub, mnemonic, and address", () => {
    expect(isBip38Key(WIF_COMPRESSED)).toBe(false);
    expect(isBip38Key(WIF_UNCOMPRESSED)).toBe(false);
    expect(isBip38Key(ZPUB)).toBe(false);
    expect(isBip38Key(MNEMONIC)).toBe(false);
    expect(isBip38Key(ADDR)).toBe(false);
    expect(isBip38Key("6Pshort")).toBe(false);
  });
});

describe("parseWalletSecret BIP38", () => {
  test("rejects a raw 6P key with a password error", () => {
    expect(() => parseWalletSecret(BIP38_FAST)).toThrow(
      /password-protected WIF requires a password/,
    );
  });

  test("inspect treats leftover 6P in KV as invalid", () => {
    const db = {
      keyValue: {
        get: () => BIP38_FAST,
        set: () => {},
      },
    };
    expect(inspectWalletSecret(db)).toEqual({
      status: "invalid",
      detail: "password-protected WIF requires a password",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/bip38.test.ts`

Expected: FAIL — `src/wallet/bip38.ts` is missing, or `isBip38Key` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `src/wallet/bip38.ts`:

```ts
export function isBip38Key(value: string): boolean {
  const v = value.trim();
  if (/\s/.test(v)) return false;
  return v.startsWith("6P") && v.length === 58;
}
```

In `src/wallet/secret.ts`, add the import and the check **after** the extended-key reject and **before** `looksLikeWifCandidate`:

```ts
import { isBip38Key } from "./bip38.ts";
```

Inside `parseWalletSecret`, after the `/^[xyzvt]p(?:ub|rv)/` reject:

```ts
  if (isBip38Key(value)) {
    throw new Error("password-protected WIF requires a password");
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/bip38.test.ts`

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/wallet/bip38.ts src/wallet/secret.ts tests/unit/bip38.test.ts
git commit -m "$(cat <<'EOF'
feat: reject BIP38 6P keys until they are decrypted.

EOF
)"
```

---

### Task 2: Accept uncompressed mainnet WIF in parse

**Files:**
- Modify: `src/wallet/secret.ts`
- Modify: `tests/unit/wif-wallet.test.ts`
- Test: `tests/unit/wif-wallet.test.ts`, `tests/unit/bip38.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `decodeWif(wif: string): { privateKey: Uint8Array; compressed: boolean }`; `decodeWifPrivateKey` returns `decodeWif(wif).privateKey` and accepts `5…`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/wif-wallet.test.ts`, replace `rejects uncompressed and garbage as WIF` with:

```ts
  test("accepts uncompressed mainnet WIF", () => {
    expect(
      parseWalletSecret(
        "5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR",
      ),
    ).toEqual({
      kind: "wif",
      value: "5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR",
    });
  });

  test("rejects garbage as WIF", () => {
    expect(() => parseWalletSecret("KnotAValidWifKeyxxxxxxxxxxx")).toThrow();
  });
```

Add to `tests/unit/bip38.test.ts`:

```ts
import { decodeWif } from "../../src/wallet/secret.ts";

describe("decodeWif", () => {
  test("marks 5… uncompressed and K/L compressed", () => {
    const raw = decodeWif(WIF_UNCOMPRESSED);
    expect(raw.compressed).toBe(false);
    expect(raw.privateKey.length).toBe(32);
    expect(decodeWif(WIF_COMPRESSED).compressed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/wif-wallet.test.ts tests/unit/bip38.test.ts`

Expected: FAIL — `parseWalletSecret` still throws `/compressed|WIF/` for `5KN7…`; `decodeWif` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/wallet/secret.ts`, replace the `WIF` codec usage with `base58check`. Add imports:

```ts
import { base58check } from "@scure/base";
import { createHash } from "node:crypto";
```

Remove `import { WIF } from "@scure/btc-signer"` and `const wifCodec = WIF();`.

Add:

```ts
function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

const wifB58 = base58check(sha256);

export function decodeWif(wif: string): {
  privateKey: Uint8Array;
  compressed: boolean;
} {
  const value = wif.trim();
  if (!value) throw new Error("invalid WIF");
  if (value.startsWith("c") || value.startsWith("9")) {
    throw new Error("only mainnet WIF is supported (not testnet)");
  }
  let parsed: Uint8Array;
  try {
    parsed = wifB58.decode(value);
  } catch {
    throw new Error("invalid WIF");
  }
  if (parsed[0] !== 0x80) {
    throw new Error("only mainnet WIF is supported (not testnet)");
  }
  if (parsed.length === 33) {
    return { privateKey: parsed.subarray(1), compressed: false };
  }
  if (parsed.length === 34 && parsed[33] === 0x01) {
    return { privateKey: parsed.subarray(1, 33), compressed: true };
  }
  throw new Error("invalid WIF");
}

export function decodeWifPrivateKey(wif: string): Uint8Array {
  return decodeWif(wif).privateKey;
}
```

`looksLikeWifCandidate` already allows `5` and length 51–52. Do not add a `startsWith("5")` reject.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/wif-wallet.test.ts tests/unit/bip38.test.ts`

Expected: PASS. Compressed WIF tests still pass. Testnet WIF still throws `/mainnet|testnet/i`.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/secret.ts tests/unit/wif-wallet.test.ts tests/unit/bip38.test.ts
git commit -m "$(cat <<'EOF'
feat: accept uncompressed mainnet WIF in parse.

EOF
)"
```

---

### Task 3: Derive one uncompressed `p2pkh` and fix receive fallback

**Files:**
- Modify: `src/wallet/derive.ts`
- Modify: `src/wallet/receive-address.ts`
- Test: `tests/unit/wif-wallet.test.ts`

**Interfaces:**
- Consumes: `decodeWif` from `src/wallet/secret.ts`
- Produces: `deriveWatchWallet("5…")` → `kind: "wif"`, exactly one `p2pkh`; `preferredWifReceiveAddress` does not require `p2wpkh`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/wif-wallet.test.ts` (keep existing compressed four-script tests):

```ts
const WIF_UNCOMPRESSED =
  "5KN7MzqK5wt2TP1fQCYyHBtDrXdJuXbUzm4A9rKAteGu3Qi5CVR";
const ADDR_UNCOMPRESSED = "1Jq6MksXQVWzrznvZzxkV6oY57oWXD9TXB";

describe("deriveWatchWallet uncompressed WIF", () => {
  test("watches only uncompressed legacy p2pkh", () => {
    const w = deriveWatchWallet(WIF_UNCOMPRESSED);
    expect(w.kind).toBe("wif");
    expect(w.addresses).toHaveLength(1);
    expect(w.scripts).toHaveLength(1);
    expect(w.addresses[0]?.scriptType).toBe("p2pkh");
    expect(w.addresses[0]?.address).toBe(ADDR_UNCOMPRESSED);
  });
});

describe("preferredWifReceiveAddress uncompressed", () => {
  test("defaults to the sole p2pkh when no txs", () => {
    const w = deriveWatchWallet(WIF_UNCOMPRESSED);
    const addr = preferredWifReceiveAddress(w, []);
    expect(addr.scriptType).toBe("p2pkh");
    expect(addr.address).toBe(ADDR_UNCOMPRESSED);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/wif-wallet.test.ts`

Expected: FAIL — derive still builds four compressed scripts; `preferredWifReceiveAddress` throws `WIF wallet missing native segwit address`.

- [ ] **Step 3: Write minimal implementation**

In `src/wallet/derive.ts`, import `decodeWif` instead of `decodeWifPrivateKey`. Replace `deriveWifWatchWallet`:

```ts
function deriveWifWatchWallet(wif: string): WatchWallet {
  const { privateKey, compressed } = decodeWif(wif);
  const publicKey = secp256k1.getPublicKey(privateKey, compressed);

  if (!compressed) {
    const pay = p2pkh(publicKey);
    if (!pay.address) {
      throw new Error("failed to encode p2pkh address from WIF");
    }
    const addr: WatchAddress = {
      path: "wif/p2pkh",
      index: 0,
      change: false,
      address: pay.address,
      scriptPubKey: new Uint8Array(pay.script),
      scriptType: "p2pkh",
    };
    return {
      kind: "wif",
      secret: wif,
      addresses: [addr],
      scripts: [addr.scriptPubKey],
    };
  }

  const xOnly = publicKey.slice(1);
  const payments: Record<
    AddressScriptType,
    { address?: string; script: Uint8Array }
  > = {
    p2pkh: p2pkh(publicKey),
    "p2sh-p2wpkh": p2sh(p2wpkh(publicKey)),
    p2wpkh: p2wpkh(publicKey),
    p2tr: p2tr(xOnly),
  };

  const addresses: WatchAddress[] = WIF_SCRIPT_TYPES.map((scriptType, index) => {
    const pay = payments[scriptType];
    if (!pay.address) {
      throw new Error(`failed to encode ${scriptType} address from WIF`);
    }
    return {
      path: `wif/${scriptType}`,
      index,
      change: false,
      address: pay.address,
      scriptPubKey: new Uint8Array(pay.script),
      scriptType,
    };
  });

  return {
    kind: "wif",
    secret: wif,
    addresses,
    scripts: addresses.map((a) => a.scriptPubKey),
  };
}
```

In `src/wallet/receive-address.ts`, replace the native-only fallback:

```ts
  const native = wallet.addresses.find((a) => a.scriptType === "p2wpkh");
  const fallback =
    native ??
    wallet.addresses.find((a) => a.scriptType === "p2pkh") ??
    wallet.addresses[0];
  if (!fallback) throw new Error("WIF wallet missing receive address");
```

Change the final `return native` to `return fallback`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/wif-wallet.test.ts`

Expected: PASS. Compressed default-receive test still returns native segwit.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/derive.ts src/wallet/receive-address.ts tests/unit/wif-wallet.test.ts
git commit -m "$(cat <<'EOF'
feat: watch one uncompressed p2pkh for 5-prefix WIF.

EOF
)"
```

---

### Task 4: Decrypt BIP38 (BlueWallet unit tests)

**Files:**
- Modify: `src/wallet/bip38.ts`
- Modify: `package.json` / lockfile (`bun add bip38@3.1.1`)
- Test: `tests/unit/bip38.test.ts`

**Interfaces:**
- Consumes: `bip38.decryptAsync`; `isBip38Key`
- Produces: `encodeWif(privateKey: Uint8Array, compressed: boolean): string`; `decryptBip38ToWif(encrypted: string, password: string, scryptParams?: { N: number; r: number; p: number }): Promise<string>`

- [ ] **Step 1: Install the library**

Run: `bun add bip38@3.1.1`

Do not add `github:BlueWallet/bip38`.

- [ ] **Step 2: Write the failing tests**

Append to `tests/unit/bip38.test.ts` (reuse the constants from Task 1):

```ts
import { decryptBip38ToWif } from "../../src/wallet/bip38.ts";
import { deriveWatchWallet } from "../../src/wallet/derive.ts";

const FAST_PASSWORD = "TestingOneTwoThree";
const FAST_SCRYPT = { N: 1, r: 8, p: 8 };

describe("decryptBip38ToWif (BlueWallet bip38.test.ts)", () => {
  test("bip38 decodes", async () => {
    const wif = await decryptBip38ToWif(
      BIP38_FAST,
      FAST_PASSWORD,
      FAST_SCRYPT,
    );
    expect(wif).toBe(WIF_UNCOMPRESSED);
  });

  test.skip("bip38 decodes slow", async () => {
    const wif = await decryptBip38ToWif(
      BIP38_SLOW,
      "qwerty",
    );
    expect(wif).toBe(
      "KxqRtpd9vFju297ACPKHrGkgXuberTveZPXbRDiQ3MXZycSQYtjc",
    );
    await expect(decryptBip38ToWif(BIP38_SLOW, "a")).rejects.toThrow(
      /incorrect password/i,
    );
  });

  test("wrong password fails with a clear error", async () => {
    await expect(
      decryptBip38ToWif(BIP38_FAST, "wrong", FAST_SCRYPT),
    ).rejects.toThrow(/incorrect password/i);
  });
});

describe("decrypt then derive", () => {
  test("fast vector becomes one uncompressed p2pkh", async () => {
    const wif = await decryptBip38ToWif(
      BIP38_FAST,
      FAST_PASSWORD,
      FAST_SCRYPT,
    );
    expect(parseWalletSecret(wif)).toEqual({
      kind: "wif",
      value: WIF_UNCOMPRESSED,
    });
    const w = deriveWatchWallet(wif);
    expect(w.kind).toBe("wif");
    expect(w.addresses).toHaveLength(1);
    expect(w.addresses[0]?.scriptType).toBe("p2pkh");
    expect(w.addresses[0]?.address).toBe(ADDR);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/bip38.test.ts`

Expected: FAIL — `decryptBip38ToWif` is not exported. The skipped test must not run.

- [ ] **Step 4: Write minimal implementation**

`bip38` is CJS. `verbatimModuleSyntax` is on. Load it with `createRequire` (do not use `import bip38 from "bip38"`).

Replace `src/wallet/bip38.ts` with:

```ts
import { base58check } from "@scure/base";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bip38 = require("bip38") as {
  decryptAsync: (
    encrypted: string,
    password: string,
    progress?: (status: { percent: number }) => void,
    scryptParams?: { N: number; r: number; p: number },
  ) => Promise<{ privateKey: Uint8Array; compressed: boolean }>;
};

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

const wifB58 = base58check(sha256);

export function isBip38Key(value: string): boolean {
  const v = value.trim();
  if (/\s/.test(v)) return false;
  return v.startsWith("6P") && v.length === 58;
}

export function encodeWif(
  privateKey: Uint8Array,
  compressed: boolean,
): string {
  if (privateKey.length !== 32) throw new Error("invalid private key");
  const body = compressed
    ? Uint8Array.of(0x80, ...privateKey, 0x01)
    : Uint8Array.of(0x80, ...privateKey);
  return wifB58.encode(body);
}

export async function decryptBip38ToWif(
  encrypted: string,
  password: string,
  scryptParams?: { N: number; r: number; p: number },
): Promise<string> {
  const key = encrypted.trim();
  if (!isBip38Key(key)) {
    throw new Error("invalid password-protected WIF");
  }
  try {
    const decrypted = await bip38.decryptAsync(
      key,
      password,
      undefined,
      scryptParams,
    );
    return encodeWif(
      new Uint8Array(decrypted.privateKey),
      decrypted.compressed,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/passphrase|password/i.test(msg)) {
      throw new Error("incorrect password");
    }
    throw new Error("invalid password-protected WIF");
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/bip38.test.ts`

Expected: PASS. `bip38 decodes slow` listed as skipped. Fast decrypt finishes in well under a second.

Run: `bun test tests/unit/wif-wallet.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wallet/bip38.ts tests/unit/bip38.test.ts package.json bun.lockb bun.lock
git commit -m "$(cat <<'EOF'
feat: decrypt BIP38 keys with npm bip38.

EOF
)"
```

Stage whichever lockfile this repo uses (`bun.lock` or `bun.lockb`). Do not commit `node_modules`.

---

### Task 5: Sign uncompressed `p2pkh`

**Files:**
- Modify: `src/wallet/build-send-tx.ts`
- Test: `tests/unit/wif-wallet.test.ts`

**Interfaces:**
- Consumes: `decodeWif` from `src/wallet/secret.ts`
- Produces: `accountKey` for `"wif"` sets `publicKey` to `secp256k1.getPublicKey(privateKey, compressed)`

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/wif-wallet.test.ts` in the signing describe (reuse `fundingTx`, `buildSend`, `Transaction` already imported):

```ts
  test("signs uncompressed legacy p2pkh", () => {
    const wallet = deriveWatchWallet(WIF_UNCOMPRESSED);
    const recv = wallet.addresses[0]!;
    const fund = fundingTx(recv.scriptPubKey, 100_000n, 41);
    const built = buildSend({
      secret: WIF_UNCOMPRESSED,
      wallet,
      utxos: [
        {
          txid: fund.txid,
          vout: 0,
          valueSats: 100_000n,
          scriptPubKey: recv.scriptPubKey,
          nonWitnessUtxo: fund.tx,
        },
      ],
      toAddress: DEST_LEGACY,
      amountSats: 40_000n,
      feeRateSatPerVb: 1,
      changeAddress: recv.address,
    });
    expect(built.kind).toBe("signed");
    if (built.kind !== "signed") throw new Error("expected signed");
    const tx = Transaction.fromRaw(hex.decode(built.txHex));
    expect(tx.inputsLength).toBe(1);
    expect(tx.outputsLength).toBe(2);
  });
```

`WIF_UNCOMPRESSED` and `ADDR_UNCOMPRESSED` are already in this file from Task 3. If you placed them inside a nested describe, hoist them next to the other WIF constants at the top of the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/wif-wallet.test.ts -t "signs uncompressed"`

Expected: FAIL — `accountKey` still builds a compressed pubkey, so `p2pkh` does not match the uncompressed script.

- [ ] **Step 3: Write minimal implementation**

In `src/wallet/build-send-tx.ts`, import `decodeWif` instead of `decodeWifPrivateKey`. Change the `"wif"` branch of `accountKey`:

```ts
  if (parsed.kind === "wif") {
    const { privateKey, compressed } = decodeWif(parsed.value);
    return {
      kind: "wif",
      privateKey,
      publicKey: secp256k1.getPublicKey(privateKey, compressed),
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/wif-wallet.test.ts tests/unit/bip38.test.ts tests/unit/send-context.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/build-send-tx.ts tests/unit/wif-wallet.test.ts
git commit -m "$(cat <<'EOF'
fix: sign uncompressed WIF with the uncompressed pubkey.

EOF
)"
```

---

### Task 6: Onboarding password step

**Files:**
- Create: `src/tui/onboarding-import.ts`
- Modify: `src/tui/OnboardingApp.tsx`
- Test: `tests/unit/bip38.test.ts`

**Interfaces:**
- Consumes: `isBip38Key`, `decryptBip38ToWif` from `src/wallet/bip38.ts`; `parseWalletSecret` from `src/wallet/secret.ts`
- Produces:
  - `classifyOnboardingSecret(raw: string): { action: "bip38"; encrypted: string } | { action: "save"; secret: string }`
  - `unlockBip38Secret(encrypted: string, password: string): Promise<string>`
  - `nextPasswordFromMaskedInput(current: string, displayed: string): string`
  - `maskPassword(value: string): string`

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/bip38.test.ts`:

```ts
import {
  classifyOnboardingSecret,
  maskPassword,
  nextPasswordFromMaskedInput,
  unlockBip38Secret,
} from "../../src/tui/onboarding-import.ts";

describe("classifyOnboardingSecret", () => {
  test("sends 6P keys to the password step", () => {
    expect(classifyOnboardingSecret(`  ${BIP38_FAST}  `)).toEqual({
      action: "bip38",
      encrypted: BIP38_FAST,
    });
  });

  test("accepts a raw WIF without a password step", () => {
    expect(classifyOnboardingSecret(WIF_UNCOMPRESSED)).toEqual({
      action: "save",
      secret: WIF_UNCOMPRESSED,
    });
  });

  test("still rejects junk", () => {
    expect(() => classifyOnboardingSecret("not-a-secret")).toThrow();
  });
});

describe("unlockBip38Secret", () => {
  test("rejects an empty password", async () => {
    await expect(unlockBip38Secret(BIP38_FAST, "   ")).rejects.toThrow(
      /password is required/i,
    );
  });

  test("returns the plain WIF", async () => {
    await expect(
      unlockBip38Secret(BIP38_FAST, FAST_PASSWORD, FAST_SCRYPT),
    ).resolves.toBe(WIF_UNCOMPRESSED);
  });
});

describe("masked password input", () => {
  test("masks to stars and applies edits", () => {
    expect(maskPassword("ab")).toBe("**");
    expect(nextPasswordFromMaskedInput("ab", "***")).toBe("ab*");
    expect(nextPasswordFromMaskedInput("ab", "*")).toBe("a");
    expect(nextPasswordFromMaskedInput("ab", "xyz")).toBe("xyz");
  });
});
```

`unlockBip38Secret` for the fast vector must pass `{ N: 1, r: 8, p: 8 }` in the **test** only if you add an optional scrypt argument. Production unlock uses official scrypt (too slow for this test). Give `unlockBip38Secret` the same optional third argument as `decryptBip38ToWif`:

```ts
export async function unlockBip38Secret(
  encrypted: string,
  password: string,
  scryptParams?: { N: number; r: number; p: number },
): Promise<string>;
```

In the test, call `unlockBip38Secret(BIP38_FAST, FAST_PASSWORD, FAST_SCRYPT)`. `OnboardingApp` calls `unlockBip38Secret(encrypted, password)` with no third argument.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/bip38.test.ts`

Expected: FAIL — `src/tui/onboarding-import.ts` is missing.

- [ ] **Step 3: Write the helper**

Create `src/tui/onboarding-import.ts`:

```ts
import {
  decryptBip38ToWif,
  isBip38Key,
} from "../wallet/bip38.ts";
import { parseWalletSecret } from "../wallet/secret.ts";

export function classifyOnboardingSecret(
  raw: string,
):
  | { action: "bip38"; encrypted: string }
  | { action: "save"; secret: string } {
  const value = raw.trim();
  if (isBip38Key(value)) {
    return { action: "bip38", encrypted: value };
  }
  const parsed = parseWalletSecret(value);
  return { action: "save", secret: parsed.value };
}

export async function unlockBip38Secret(
  encrypted: string,
  password: string,
  scryptParams?: { N: number; r: number; p: number },
): Promise<string> {
  if (!password.trim()) {
    throw new Error("password is required");
  }
  const wif = await decryptBip38ToWif(encrypted, password, scryptParams);
  return parseWalletSecret(wif).value;
}

export function maskPassword(value: string): string {
  return "*".repeat(value.length);
}

export function nextPasswordFromMaskedInput(
  current: string,
  displayed: string,
): string {
  const stars = maskPassword(current);
  if (displayed.length < current.length) {
    return current.slice(0, displayed.length);
  }
  if (displayed.startsWith(stars)) {
    return current + displayed.slice(current.length);
  }
  return displayed;
}
```

- [ ] **Step 4: Wire `OnboardingApp`**

In `src/tui/OnboardingApp.tsx`:

- Change `type Step` to `"choose" | "import" | "bip38-password" | "create" | "year"`.
- Add state: `encryptedBip38` (`string | null`, default `null`) and `password` (`""`).
- Replace `submitSecret` so it classifies first:

```ts
  function submitSecret(raw: string) {
    try {
      const next = classifyOnboardingSecret(raw);
      if (next.action === "bip38") {
        setEncryptedBip38(next.encrypted);
        setPassword("");
        setError(null);
        setStep("bip38-password");
        return;
      }
      setError(null);
      onSecretValidated(next.secret);
      setStep("year");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function submitBip38Password() {
    if (busy || !encryptedBip38) return;
    if (!password.trim()) {
      setError("password is required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const wif = await unlockBip38Secret(encryptedBip38, password);
      setPassword("");
      setEncryptedBip38(null);
      onSecretValidated(wif);
      setStep("year");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
```

- Esc: if `step === "bip38-password"`, clear `password` and `error`, set `step` to `"import"`. Do not clear the import `value` (keep the `6P…` text). Do not clear `encryptedBip38` until a successful unlock (or keep it; the import field still has the text).
- Import copy: `Enter BIP39 seed, account zpub, WIF (or password-protected WIF), or address`
- Placeholder may stay `seed words, zpub, WIF, or address…`
- Add the password panel (same width/height as Import):

```tsx
      {step === "bip38-password" ? (
        <box width="80%" height={8} flexGrow={0}>
          <Panel title="Password" state="active" accent="magenta" height="100%">
            <text fg={THEME.fgDim}>
              This WIF is password-protected. Enter the password.
            </text>
            <input
              focused={!busy}
              value={maskPassword(password)}
              placeholder="password…"
              onInput={(v) => {
                setPassword((prev) => nextPasswordFromMaskedInput(prev, v));
                if (error) setError(null);
              }}
              onSubmit={() => {
                void submitBip38Password();
              }}
            />
            <text fg={error ? THEME.accentMagenta : THEME.fgDim}>
              {busy
                ? "Decrypting…"
                : (error ?? "Enter to continue · Esc to go back")}
            </text>
          </Panel>
        </box>
      ) : null}
```

Import `classifyOnboardingSecret`, `unlockBip38Secret`, `maskPassword`, and `nextPasswordFromMaskedInput` from `./onboarding-import.ts`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/unit/bip38.test.ts tests/unit/wif-wallet.test.ts tests/unit/onboarding-gate.test.ts`

Expected: PASS.

Run: `bun run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tui/onboarding-import.ts src/tui/OnboardingApp.tsx tests/unit/bip38.test.ts
git commit -m "$(cat <<'EOF'
feat: ask for a password when importing a BIP38 WIF.

EOF
)"
```

---

## Self-review

**Spec coverage**

| Spec item | Task |
|-----------|------|
| Detect 58-char `6P…` | 1 |
| Reject raw `6P…` as `wallet_secret` / inspect invalid | 1 |
| Accept raw `5…` | 2 |
| `decodeWif` compressed flag | 2 |
| Uncompressed → one `p2pkh` | 3 |
| Receive fallback without native | 3 |
| npm `bip38` + BlueWallet fast/slow tests | 4 |
| Wrong password / invalid `6P` errors | 4 |
| Decrypt then derive address `1Jq6Mks…` | 4 |
| Sign with uncompressed pubkey | 5 |
| Password step, mask, Esc keeps `6P…`, busy, empty password | 6 |
| Store plain WIF via existing `onSecretValidated` | 6 |

**Placeholder scan:** no TBD / “add validation later” / “similar to Task N”.

**Type names:** `isBip38Key`, `encodeWif`, `decryptBip38ToWif`, `decodeWif`, `classifyOnboardingSecret`, `unlockBip38Secret`, `maskPassword`, `nextPasswordFromMaskedInput` — used the same way in later tasks.

**Note:** Spec said encode with `@scure/btc-signer` `WIF()`. That codec rejects uncompressed payloads. Tasks 2 and 4 use `base58check` instead so `5…` round-trips.
