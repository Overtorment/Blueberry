# Receive / Send Floating Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add App-stage floating Receive/Send actions that open placeholder modals above the Transactions stage via a global UI route store.

**Architecture:** In-memory `ui-route-store` (`"txs" | "receive" | "send"`) drives App overlays. `Transactions` stays list-only. A relative stage box wraps Transactions; absolute `ActionBar` and `WalletModal` siblings float above it with higher `zIndex`.

**Tech Stack:** Bun, TypeScript, React 19, OpenTUI (`@opentui/react` / `@opentui/core`), existing TUI store + `useSyncExternalStore` pattern.

## Global Constraints

- Placeholders only — no receive address / send logic
- Buttons and modal are App-stage siblings — never inside `Transactions` / `Panel`
- Modal overlays the Transactions stage only (strip + Balance stay visible)
- Action bar: bottom-center; do not change `reservedLines` / `txListCapacity`
- Dismiss: visible Close + Esc → `"txs"`; global `q` still quits (including while modal open)
- Accents: Receive = magenta, Send = cyan; 256-color `THEME` only
- Spec: `docs/superpowers/specs/2026-08-06-blueberry-receive-send-floating-actions-design.md`

---

## File map

| File | Role |
|------|------|
| `src/tui/ui-route-store.ts` | Route store (`get` / `subscribe` / `open` / `close`) |
| `src/tui/use-ui-route.ts` | Active store + `useUiRoute` / `useUiRouteStore` hooks |
| `src/tui/components/ActionBar.tsx` | Floating Receive / Send |
| `src/tui/components/WalletModal.tsx` | Placeholder modal + Close |
| `src/tui/App.tsx` | Stage wrapper, mount overlays, Esc → `close()` |
| `src/main.tsx` | Create + `setActiveUiRouteStore` |
| `tests/ui-route-store.test.ts` | Store unit tests |

---

### Task 1: UI route store + hook + bootstrap

**Files:**
- Create: `src/tui/ui-route-store.ts`
- Create: `src/tui/use-ui-route.ts`
- Create: `tests/ui-route-store.test.ts`
- Modify: `src/main.tsx` (after wallet txs store activate, before `createWallet`)

**Interfaces:**
- Consumes: none
- Produces:
  - `export type UiRoute = "txs" | "receive" | "send"`
  - `export type UiRouteStore = { get(): UiRoute; subscribe(listener: () => void): () => void; open(route: "receive" | "send"): void; close(): void }`
  - `createUiRouteStore(): UiRouteStore`
  - `setActiveUiRouteStore(store: UiRouteStore): void`
  - `useUiRoute(): UiRoute`
  - `useUiRouteStore(): UiRouteStore | null`

- [ ] **Step 1: Write the failing test**

Create `tests/ui-route-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createUiRouteStore } from "../src/tui/ui-route-store.ts";

describe("ui route store", () => {
  test("starts at txs; open/close; idempotent open; notifies once per change", () => {
    const store = createUiRouteStore();
    expect(store.get()).toBe("txs");

    let n = 0;
    const unsub = store.subscribe(() => {
      n++;
    });

    store.open("receive");
    expect(store.get()).toBe("receive");
    expect(n).toBe(1);

    store.open("receive");
    expect(n).toBe(1);

    store.open("send");
    expect(store.get()).toBe("send");
    expect(n).toBe(2);

    store.close();
    expect(store.get()).toBe("txs");
    expect(n).toBe(3);

    store.close();
    expect(n).toBe(3);

    unsub();
    store.open("receive");
    expect(n).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/ui-route-store.test.ts`

Expected: FAIL (module not found / `createUiRouteStore` undefined)

- [ ] **Step 3: Implement store**

Create `src/tui/ui-route-store.ts`:

```ts
export type UiRoute = "txs" | "receive" | "send";

export type UiRouteStore = {
  get(): UiRoute;
  subscribe(listener: () => void): () => void;
  open(route: "receive" | "send"): void;
  close(): void;
};

export function createUiRouteStore(): UiRouteStore {
  let route: UiRoute = "txs";
  const listeners = new Set<() => void>();

  function set(next: UiRoute): void {
    if (route === next) return;
    route = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    get() {
      return route;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open(next) {
      set(next);
    },
    close() {
      set("txs");
    },
  };
}
```

- [ ] **Step 4: Implement hook**

Create `src/tui/use-ui-route.ts` (mirror `use-wallet-txs.ts`):

```ts
import { useSyncExternalStore } from "react";
import type { UiRoute, UiRouteStore } from "./ui-route-store.ts";

let activeStore: UiRouteStore | null = null;

export function setActiveUiRouteStore(store: UiRouteStore): void {
  activeStore = store;
}

export function useUiRouteStore(): UiRouteStore | null {
  return activeStore;
}

export function useUiRoute(): UiRoute {
  const store = activeStore;
  return useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get() ?? "txs",
    () => store?.get() ?? "txs",
  );
}
```

- [ ] **Step 5: Bootstrap in main**

In `src/main.tsx` `startApp`, after `setActiveWalletTxsStore(walletTxsStore)`:

```ts
import { createUiRouteStore } from "./tui/ui-route-store.ts";
import { setActiveUiRouteStore } from "./tui/use-ui-route.ts";

// ...
const uiRouteStore = createUiRouteStore();
setActiveUiRouteStore(uiRouteStore);
```

Do not pass the store into `createTuiModule` (UI-only; no bus events).

- [ ] **Step 6: Run tests**

Run: `bun test tests/ui-route-store.test.ts`

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/tui/ui-route-store.ts src/tui/use-ui-route.ts tests/ui-route-store.test.ts src/main.tsx
git commit -m "$(cat <<'EOF'
Add UI route store for Receive/Send navigation.

EOF
)"
```

---

### Task 2: ActionBar + App stage wrapper

**Files:**
- Create: `src/tui/components/ActionBar.tsx`
- Modify: `src/tui/App.tsx`

**Interfaces:**
- Consumes: `useUiRoute()`, `useUiRouteStore()`, `THEME`, OpenTUI `box` absolute layout
- Produces: `ActionBar` component; App stage hosts Transactions + ActionBar

- [ ] **Step 1: Create ActionBar**

Create `src/tui/components/ActionBar.tsx`:

```tsx
import { THEME } from "../theme.ts";
import { useUiRouteStore } from "../use-ui-route.ts";

function ActionButton(props: {
  label: string;
  accent: "magenta" | "cyan";
  onPress: () => void;
}) {
  const color =
    props.accent === "magenta" ? THEME.accentMagenta : THEME.accentCyan;
  return (
    <box
      border
      borderStyle="single"
      borderColor={color}
      backgroundColor={THEME.bg}
      paddingX={1}
      onMouseDown={() => props.onPress()}
    >
      <text fg={color}>{props.label}</text>
    </box>
  );
}

/** Floating bottom-center Receive / Send — App-stage sibling, not inside Transactions. */
export function ActionBar() {
  const store = useUiRouteStore();
  return (
    <box
      position="absolute"
      left={0}
      right={0}
      bottom={1}
      height={3}
      zIndex={10}
      flexDirection="row"
      justifyContent="center"
      alignItems="center"
      gap={2}
    >
      <ActionButton
        label="Receive"
        accent="magenta"
        onPress={() => store?.open("receive")}
      />
      <ActionButton
        label="Send"
        accent="cyan"
        onPress={() => store?.open("send")}
      />
    </box>
  );
}
```

- [ ] **Step 2: Wire App stage**

Replace the Transactions row in `src/tui/App.tsx` with a relative stage; show ActionBar only when route is `"txs"`:

```tsx
import { useKeyboard } from "@opentui/react";
import { ActionBar } from "./components/ActionBar.tsx";
import { WalletModal } from "./components/WalletModal.tsx";
import { useUiRoute, useUiRouteStore } from "./use-ui-route.ts";
// ... existing imports ...

export function App() {
  const route = useUiRoute();
  const uiRouteStore = useUiRouteStore();

  useKeyboard((key) => {
    if (key.name === "escape") uiRouteStore?.close();
  });

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      padding={1}
      backgroundColor={THEME.bg}
    >
      {/* strip + balance unchanged */}

      <box
        width="100%"
        flexGrow={1}
        position="relative"
        flexDirection="column"
      >
        <Transactions />
        {route === "txs" ? <ActionBar /> : null}
        {route === "receive" || route === "send" ? (
          <WalletModal kind={route} />
        ) : null}
      </box>
    </box>
  );
}
```

Keep the strip and Balance rows exactly as today. Remove the old `flexDirection="row" gap={1}` wrapper around Transactions (stage is a single column relative box).

Note: `WalletModal` is referenced here but implemented in Task 3 — either stub a minimal export in the same commit as Task 3, or land Task 2 App changes with ActionBar only and add modal mount in Task 3. **Preferred:** Task 2 mounts ActionBar only; Task 3 adds `WalletModal` import + conditional + Esc handler.

So for Task 2, App becomes:

```tsx
import { ActionBar } from "./components/ActionBar.tsx";
import { useUiRoute } from "./use-ui-route.ts";
// ... 

export function App() {
  const route = useUiRoute();

  return (
    <box /* root unchanged */>
      {/* strip unchanged */}
      {/* balance unchanged */}

      <box
        width="100%"
        flexGrow={1}
        position="relative"
        flexDirection="column"
      >
        <Transactions />
        {route === "txs" ? <ActionBar /> : null}
      </box>
    </box>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`

Expected: PASS (no errors in new files)

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `bun start` (or project’s usual entry)

Confirm: Receive/Send float bottom-center over Transactions; panel title/border unchanged; buttons are not inside the Transactions border chrome.

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/ActionBar.tsx src/tui/App.tsx
git commit -m "$(cat <<'EOF'
Float Receive/Send actions above the Transactions stage.

EOF
)"
```

---

### Task 3: WalletModal placeholder + Esc / Close

**Files:**
- Create: `src/tui/components/WalletModal.tsx`
- Modify: `src/tui/App.tsx` (mount modal + Esc)

**Interfaces:**
- Consumes: `useUiRouteStore()`, `THEME`, route `"receive" | "send"`
- Produces: `WalletModal({ kind: "receive" | "send" })`

- [ ] **Step 1: Create WalletModal**

Create `src/tui/components/WalletModal.tsx`:

```tsx
import { THEME } from "../theme.ts";
import { useUiRouteStore } from "../use-ui-route.ts";

export type WalletModalProps = {
  kind: "receive" | "send";
};

export function WalletModal({ kind }: WalletModalProps) {
  const store = useUiRouteStore();
  const accent =
    kind === "receive" ? THEME.accentMagenta : THEME.accentCyan;
  const title = kind === "receive" ? "Receive" : "Send";

  return (
    <box
      position="absolute"
      left={0}
      right={0}
      top={0}
      bottom={0}
      zIndex={20}
      justifyContent="center"
      alignItems="center"
      backgroundColor={THEME.bg}
    >
      <box
        width="60%"
        height={8}
        border
        borderStyle="double"
        borderColor={accent}
        title={`◆ ${title}`}
        titleColor={accent}
        backgroundColor={THEME.bg}
        paddingX={1}
        paddingY={1}
        flexDirection="column"
        gap={1}
      >
        <text fg={THEME.fgDim}>Coming soon</text>
        <box
          border
          borderStyle="single"
          borderColor={THEME.fgDim}
          paddingX={1}
          alignSelf="flex-start"
          onMouseDown={() => store?.close()}
        >
          <text fg={THEME.fg}>Close</text>
        </box>
      </box>
    </box>
  );
}
```

Full-stage dimming: the outer absolute box uses `THEME.bg` so the tx list is covered for this placeholder pass (spec allows overlay over the stage; full translucent dim is not required).

- [ ] **Step 2: Mount modal + Esc in App**

Update `src/tui/App.tsx`:

```tsx
import { useKeyboard } from "@opentui/react";
import { ActionBar } from "./components/ActionBar.tsx";
import { WalletModal } from "./components/WalletModal.tsx";
import { useUiRoute, useUiRouteStore } from "./use-ui-route.ts";
// ... existing imports ...

export function App() {
  const route = useUiRoute();
  const uiRouteStore = useUiRouteStore();

  useKeyboard((key) => {
    if (key.name === "escape") uiRouteStore?.close();
  });

  return (
    <box /* root */>
      {/* strip + balance unchanged */}
      <box
        width="100%"
        flexGrow={1}
        position="relative"
        flexDirection="column"
      >
        <Transactions />
        {route === "txs" ? <ActionBar /> : null}
        {route === "receive" || route === "send" ? (
          <WalletModal kind={route} />
        ) : null}
      </box>
    </box>
  );
}
```

Do **not** change `main.tsx` `q` quit handler.

- [ ] **Step 3: Typecheck + store tests**

Run: `bun run typecheck && bun test tests/ui-route-store.test.ts`

Expected: PASS

- [ ] **Step 4: Manual verify**

Run app:

1. Click Receive → magenta placeholder modal, action bar hidden
2. Close → txs + bar return
3. Click Send → cyan placeholder
4. Esc → closes modal
5. With modal open, `q` still quits the process

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/WalletModal.tsx src/tui/App.tsx \
  docs/superpowers/plans/2026-08-06-blueberry-receive-send-floating-actions.md
git commit -m "$(cat <<'EOF'
Add Receive/Send placeholder modals with Esc dismiss.

EOF
)"
```

---

## Spec coverage (self-review)

| Spec requirement | Task |
|------------------|------|
| UI route store | Task 1 |
| App-stage siblings, not inside Transactions | Task 2–3 |
| Bottom-center floating bar | Task 2 |
| Placeholder modal over stage | Task 3 |
| Close + Esc | Task 3 |
| `q` unchanged quit | Task 3 (explicit non-change) |
| Receive magenta / Send cyan | Task 2–3 |
| No reservedLines change | Task 2 (non-change) |
| Store unit tests | Task 1 |
