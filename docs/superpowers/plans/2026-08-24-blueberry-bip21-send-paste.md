# BIP21 Send Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user pastes a BIP21 `bitcoin:` URI into the send Address field, parse it and fill Address, Amount, and Payment label.

**Architecture:** Add a pure `parseBip21()` helper in `src/parse/bip21.ts`. `SendDetailsForm` calls it from Address `onInput`. A successful parse writes the extracted fields; `null` leaves the typed Address value unchanged.

**Tech Stack:** Bun, TypeScript, bun:test, existing send TUI (`SendDetailsForm` in `WalletModal.tsx`), existing `isAddressValid` and `parseBtcToSats`.

## Global Constraints

- Parse lives in `parseBip21()` in `src/parse/bip21.ts`. No new package
- Scheme `bitcoin:` is case-insensitive. Optional `//` after the colon
- Payment label source: `label` if present and non-empty after trim. Else `message`
- Missing URI fields do not clear fields the user already typed
- Present URI fields overwrite the current Amount / Payment label
- Bad amount still returns address and label. Keep the amount text. Mark Amount invalid now
- Bad address in a URI: still split. Mark Address invalid now
- Unknown `req-*`: whole parse fails (`null`). Address keeps the raw paste
- Extra optional params: ignore (`lightning` and others)
- Lightning-only URI (no on-chain address): `null`
- Bad encoding on one query value: drop that one param. Still parse the rest
- Focus after parse stays on Address. ↑/↓ unchanged
- Enter after fill: same validation as today
- Component tests: none. Parser unit tests only
- Do not call `isAddressValid` or `parseBtcToSats` inside `parseBip21`
- Do not use `URLSearchParams` (`+` must stay `+`)
- Spec: `docs/superpowers/specs/2026-08-24-blueberry-bip21-send-paste-design.md`

---

## File structure

| File | Responsibility |
|------|----------------|
| `src/parse/bip21.ts` | `Bip21Payment` type and `parseBip21()` |
| `tests/unit/parse-bip21.test.ts` | Parser cases from the spec |
| `src/tui/components/WalletModal.tsx` | Address `onInput` splits a BIP21 paste into the three fields |

---

### Task 1: `parseBip21`

**Files:**
- Create: `src/parse/bip21.ts`
- Create: `tests/unit/parse-bip21.test.ts`

**Interfaces:**
- Consumes: none
- Produces:
  - `export type Bip21Payment = { address: string; amount: string | null; label: string | null }`
  - `export function parseBip21(input: string): Bip21Payment | null`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/parse-bip21.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseBip21 } from "../../src/parse/bip21.ts";

const ADDR = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

describe("parseBip21", () => {
  test("parses address only", () => {
    expect(parseBip21(`bitcoin:${ADDR}`)).toEqual({
      address: ADDR,
      amount: null,
      label: null,
    });
  });

  test("parses amount", () => {
    expect(parseBip21(`bitcoin:${ADDR}?amount=0.01`)).toEqual({
      address: ADDR,
      amount: "0.01",
      label: null,
    });
  });

  test("parses label", () => {
    expect(parseBip21(`bitcoin:${ADDR}?label=rent`)).toEqual({
      address: ADDR,
      amount: null,
      label: "rent",
    });
  });

  test("uses message when label is absent", () => {
    expect(parseBip21(`bitcoin:${ADDR}?message=lunch`)).toEqual({
      address: ADDR,
      amount: null,
      label: "lunch",
    });
  });

  test("label wins over message", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?label=rent&message=lunch`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "rent",
    });
  });

  test("percent-decodes label and message", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?label=foo%20bar%26baz`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "foo bar&baz",
    });
    expect(
      parseBip21(`bitcoin:${ADDR}?message=hello%20world`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "hello world",
    });
  });

  test("keeps plus signs in query values", () => {
    expect(parseBip21(`bitcoin:${ADDR}?label=a+b`)).toEqual({
      address: ADDR,
      amount: null,
      label: "a+b",
    });
  });

  test("accepts BITCOIN: and optional //", () => {
    expect(parseBip21(`BITCOIN:${ADDR}`)).toEqual({
      address: ADDR,
      amount: null,
      label: null,
    });
    expect(parseBip21(`bitcoin://${ADDR}`)).toEqual({
      address: ADDR,
      amount: null,
      label: null,
    });
  });

  test("unknown req- param returns null", () => {
    expect(parseBip21(`bitcoin:${ADDR}?req-foo=1`)).toBeNull();
  });

  test("known req-amount and req-label still parse", () => {
    expect(parseBip21(`bitcoin:${ADDR}?req-amount=0.5`)).toEqual({
      address: ADDR,
      amount: "0.5",
      label: null,
    });
    expect(parseBip21(`bitcoin:${ADDR}?req-label=rent`)).toEqual({
      address: ADDR,
      amount: null,
      label: "rent",
    });
  });

  test("lightning-only URI returns null", () => {
    expect(parseBip21("bitcoin:?lightning=lnbc1dummy")).toBeNull();
  });

  test("not a URI returns null", () => {
    expect(parseBip21(ADDR)).toBeNull();
    expect(parseBip21("")).toBeNull();
    expect(parseBip21("  ")).toBeNull();
  });

  test("bad amount still returns address and label", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?amount=abc&label=rent`),
    ).toEqual({
      address: ADDR,
      amount: "abc",
      label: "rent",
    });
  });

  test("empty label falls back to message", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?label=&message=lunch`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "lunch",
    });
    expect(
      parseBip21(`bitcoin:${ADDR}?label=%20&message=lunch`),
    ).toEqual({
      address: ADDR,
      amount: null,
      label: "lunch",
    });
  });

  test("trims whitespace around the whole URI", () => {
    expect(parseBip21(`  bitcoin:${ADDR}?amount=1  `)).toEqual({
      address: ADDR,
      amount: "1",
      label: null,
    });
  });

  test("drops a badly encoded query pair and parses the rest", () => {
    expect(
      parseBip21(`bitcoin:${ADDR}?label=%ZZ&amount=0.01`),
    ).toEqual({
      address: ADDR,
      amount: "0.01",
      label: null,
    });
  });

  test("empty amount param is present as empty string", () => {
    expect(parseBip21(`bitcoin:${ADDR}?amount=`)).toEqual({
      address: ADDR,
      amount: "",
      label: null,
    });
  });

  test("bitcoin: with no address returns null", () => {
    expect(parseBip21("bitcoin:")).toBeNull();
    expect(parseBip21("bitcoin://")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/parse-bip21.test.ts`

Expected: FAIL — `Cannot find module '../../src/parse/bip21.ts'` or `parseBip21` is not exported

- [ ] **Step 3: Write minimal implementation**

Create `src/parse/bip21.ts`:

```ts
export type Bip21Payment = {
  address: string;
  amount: string | null;
  label: string | null;
};

const SCHEME = /^bitcoin:/i;
const KNOWN_REQ = new Set(["amount", "label", "message"]);

function decodeOrRaw(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function decodeOrDrop(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function firstNonEmpty(
  params: Map<string, string>,
  name: string,
): string | null {
  const raw = params.get(name) ?? params.get(`req-${name}`);
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseBip21(input: string): Bip21Payment | null {
  const trimmed = input.trim();
  if (!SCHEME.test(trimmed)) return null;

  let rest = trimmed.replace(SCHEME, "");
  if (rest.startsWith("//")) rest = rest.slice(2);

  const q = rest.indexOf("?");
  const addressRaw = q === -1 ? rest : rest.slice(0, q);
  const query = q === -1 ? "" : rest.slice(q + 1);

  const address = decodeOrRaw(addressRaw).trim();
  if (!address) return null;

  const params = new Map<string, string>();
  if (query.length > 0) {
    for (const piece of query.split("&")) {
      if (!piece) continue;
      const eq = piece.indexOf("=");
      const rawName = eq === -1 ? piece : piece.slice(0, eq);
      const rawValue = eq === -1 ? "" : piece.slice(eq + 1);
      const name = decodeOrDrop(rawName);
      const value = decodeOrDrop(rawValue);
      if (name === null || value === null) continue;
      const key = name.toLowerCase();
      if (!params.has(key)) params.set(key, value);
    }
  }

  for (const key of params.keys()) {
    if (key.startsWith("req-") && !KNOWN_REQ.has(key.slice(4))) return null;
  }

  let amount: string | null = null;
  if (params.has("amount")) amount = params.get("amount")!;
  else if (params.has("req-amount")) amount = params.get("req-amount")!;

  const label = firstNonEmpty(params, "label") ?? firstNonEmpty(params, "message");

  return { address, amount, label };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `bun test tests/unit/parse-bip21.test.ts`

Expected: PASS — all `parseBip21` tests

- [ ] **Step 5: Commit**

```bash
git add src/parse/bip21.ts tests/unit/parse-bip21.test.ts
git commit -m "$(cat <<'EOF'
feat: parse BIP21 bitcoin payment URIs

EOF
)"
```

---

### Task 2: Prefill send details from Address paste

**Files:**
- Modify: `src/tui/components/WalletModal.tsx`

**Interfaces:**
- Consumes: `parseBip21(input: string): Bip21Payment | null` from `src/parse/bip21.ts`
- Consumes: existing `isAddressValid` and `parseBtcToSats`
- Produces: Address `onInput` in `SendDetailsForm` writes parsed address / amount / label and live invalid marks

The spec forbids OpenTUI component tests. Do not add any. Verify with typecheck and the Task 1 tests.

- [ ] **Step 1: Add the import**

In `src/tui/components/WalletModal.tsx`, next to the existing `parse/format.ts` import, add:

```ts
import { parseBip21 } from "../../parse/bip21.ts";
```

Keep:

```ts
import { isSendMaxAmount, parseBtcToSats } from "../../parse/format.ts";
```

- [ ] **Step 2: Replace Address `onInput`**

In `SendDetailsForm`, replace the Address `<input>` `onInput` (the block that only calls `setAddress` / `setAddressInvalid`) with:

```tsx
        onInput={(v) => {
          const parsed = parseBip21(v);
          if (!parsed) {
            setAddress(v);
            if (addressInvalid) setAddressInvalid(false);
            return;
          }
          setAddress(parsed.address);
          if (parsed.amount !== null) {
            setAmount(parsed.amount);
            setAmountInvalid(parseBtcToSats(parsed.amount) === null);
          }
          if (parsed.label !== null) {
            setPaymentLabel(parsed.label);
            if (labelInvalid) setLabelInvalid(false);
          }
          setAddressInvalid(!isAddressValid(parsed.address));
        }}
```

Do not change Amount `onInput`, Payment label `onInput`, ↑/↓, or Enter validation.

- [ ] **Step 3: Typecheck and re-run parser tests**

Run:

```bash
bun test tests/unit/parse-bip21.test.ts
bun run typecheck
```

Expected: parser tests PASS; `tsc --noEmit` exits 0

- [ ] **Step 4: Commit**

```bash
git add src/tui/components/WalletModal.tsx
git commit -m "$(cat <<'EOF'
feat: prefill send details from a pasted BIP21 URI

EOF
)"
```
