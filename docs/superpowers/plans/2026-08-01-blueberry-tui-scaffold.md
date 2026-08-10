# blueberry TUI Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold an empty Bun + OpenTUI React app that launches via `bun start` and shows seven bordered empty tile windows (Transactions tall).

**Architecture:** A Bun TypeScript ESM package boots `createCliRenderer` + `createRoot`, mounts `App`, which lays out seven independent empty panel components in a 3-row flex grid. No domain logic.

**Tech Stack:** Bun, TypeScript, React 19.2, `@opentui/core` ^0.4.5, `@opentui/react` ^0.4.5, plus listed Bitcoin deps (installed, unused).

## Global Constraints

- Dependencies exactly as in the approved spec (`bip324`/`bip157`/`bip158`/`bitcoin-headers` via `file:../…`, `@scure/*`, `bitcoinjs-lib` 7.0.1, `@opentui/*` ^0.4.5, `react` ^19.2.0).
- Entry script: `"start": "bun src/main.tsx"`.
- Layout: row1 Balance | Chain tip sync | Peers; row2 Filters download | Filters matching | Blocks download; row3 Transactions (`flexGrow`, only tall panel).
- Each window is its own React component with border + title and empty body.
- No top bar, no footer, no theme system, no tests, no sync/wallet code.
- Do not copy from other codebases; decide from this plan and OpenTUI docs only.
- Commits: only when the user explicitly asks (this tree lives under the home git repo).

---

### Task 1: Package + TypeScript project shell

### Task 1: Package + TypeScript project shell

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/opentui-env.d.ts`

**Interfaces:**
- Consumes: none
- Produces: installable Bun package with `bun start` script pointing at `src/main.tsx`; TypeScript configured for OpenTUI JSX

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "blueberry",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun src/main.tsx",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "bip324": "file:../bip324",
    "bip157": "file:../bip157",
    "bip158": "file:../bip158",
    "bitcoin-headers": "file:../bitcoin-headers",
    "@scure/bip32": "^1.7.0",
    "@scure/bip39": "^1.6.0",
    "@scure/btc-signer": "^1.8.1",
    "bitcoinjs-lib": "7.0.1",
    "@opentui/core": "^0.4.5",
    "@opentui/react": "^0.4.5",
    "react": "^19.2.0"
  },
  "devDependencies": {
    "@types/bun": "^1.3.14",
    "@types/react": "^19.2.0",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"],
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `src/opentui-env.d.ts`**

```ts
import "@opentui/react";
```

- [ ] **Step 4: Install dependencies**

Run from the repo root:

```bash
bun install
```

Expected: `bun.lock` created; `node_modules` includes `@opentui/react`, `@opentui/core`, `react`, and the four `file:../` packages resolve without error.

- [ ] **Step 5: Verify package scripts exist**

Run:

```bash
bun run --silent typecheck 2>&1 | head -20; test -f package.json && node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts.start==='bun src/main.tsx'||process.exit(1)"
```

Expected: `start` script is `bun src/main.tsx`. Typecheck may fail until source files exist (acceptable until Task 3).

---


### Task 2: Empty window components

**Files:**
- Create: `src/components/Balance.tsx`
- Create: `src/components/ChainTipSync.tsx`
- Create: `src/components/Peers.tsx`
- Create: `src/components/FiltersDownload.tsx`
- Create: `src/components/FiltersMatching.tsx`
- Create: `src/components/BlocksDownload.tsx`
- Create: `src/components/Transactions.tsx`

**Interfaces:**
- Consumes: OpenTUI intrinsic `box` element
- Produces: seven components, each `export function <Name>(): JSX.Element` with no props; bordered titled empty body; layout size controlled by parent via `flexGrow` / `height` on the root `box`

Shared panel shape (repeat per file with the correct title string):

```tsx
export function Balance() {
  return (
    <box
      title="Balance"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    />
  );
}
```

- [ ] **Step 1: Create `src/components/Balance.tsx`**

```tsx
export function Balance() {
  return (
    <box
      title="Balance"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    />
  );
}
```

- [ ] **Step 2: Create `src/components/ChainTipSync.tsx`**

```tsx
export function ChainTipSync() {
  return (
    <box
      title="Chain tip sync"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    />
  );
}
```

- [ ] **Step 3: Create `src/components/Peers.tsx`**

```tsx
export function Peers() {
  return (
    <box
      title="Peers"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    />
  );
}
```

- [ ] **Step 4: Create `src/components/FiltersDownload.tsx`**

```tsx
export function FiltersDownload() {
  return (
    <box
      title="Filters download"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    />
  );
}
```

- [ ] **Step 5: Create `src/components/FiltersMatching.tsx`**

```tsx
export function FiltersMatching() {
  return (
    <box
      title="Filters matching"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    />
  );
}
```

- [ ] **Step 6: Create `src/components/BlocksDownload.tsx`**

```tsx
export function BlocksDownload() {
  return (
    <box
      title="Blocks download"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    />
  );
}
```

- [ ] **Step 7: Create `src/components/Transactions.tsx`**

```tsx
export function Transactions() {
  return (
    <box
      title="Transactions"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    />
  );
}
```

- [ ] **Step 8: Sanity-check component files exist with expected titles**

Run:

```bash
rg -n 'title="(Balance|Chain tip sync|Peers|Filters download|Filters matching|Blocks download|Transactions)"' src/components
```

Expected: seven matches, one per title.

---


### Task 3: App grid + main entrypoint

**Files:**
- Create: `src/App.tsx`
- Create: `src/main.tsx`

**Interfaces:**
- Consumes: `Balance`, `ChainTipSync`, `Peers`, `FiltersDownload`, `FiltersMatching`, `BlocksDownload`, `Transactions` (no props)
- Produces: `export function App(): JSX.Element`; `main.tsx` top-level await bootstrap using `createCliRenderer` + `createRoot`

- [ ] **Step 1: Write `src/App.tsx`**

```tsx
import { Balance } from "./components/Balance.tsx";
import { BlocksDownload } from "./components/BlocksDownload.tsx";
import { ChainTipSync } from "./components/ChainTipSync.tsx";
import { FiltersDownload } from "./components/FiltersDownload.tsx";
import { FiltersMatching } from "./components/FiltersMatching.tsx";
import { Peers } from "./components/Peers.tsx";
import { Transactions } from "./components/Transactions.tsx";

const SHORT_ROW_HEIGHT = 8;

export function App() {
  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      padding={1}
    >
      <box
        width="100%"
        height={SHORT_ROW_HEIGHT}
        flexDirection="row"
        flexGrow={0}
        gap={1}
      >
        <Balance />
        <ChainTipSync />
        <Peers />
      </box>

      <box
        width="100%"
        height={SHORT_ROW_HEIGHT}
        flexDirection="row"
        flexGrow={0}
        gap={1}
      >
        <FiltersDownload />
        <FiltersMatching />
        <BlocksDownload />
      </box>

      <box width="100%" flexDirection="row" flexGrow={1} gap={1}>
        <Transactions />
      </box>
    </box>
  );
}
```

- [ ] **Step 2: Write `src/main.tsx`**

```tsx
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./App.tsx";

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
});

createRoot(renderer).render(<App />);
```

- [ ] **Step 3: Typecheck**

Run:

```bash
bun run typecheck
```

Expected: exit code 0, no errors.

- [ ] **Step 4: Manual launch smoke check**

Run:

```bash
bun start
```

Expected: terminal shows three rows of bordered titled tiles:
- Row 1: Balance, Chain tip sync, Peers
- Row 2: Filters download, Filters matching, Blocks download
- Row 3: Transactions (taller than the short rows)

Quit with Ctrl+C. Process exits cleanly.

If OpenTUI rejects a prop (e.g. `border` vs `style={{ border: true }}`), adjust props to match `@opentui/react` ^0.4.5 typings while keeping border + title + the same grid; re-run typecheck and `bun start`.

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Bun project + listed dependencies | Task 1 |
| `bun start` launches TUI | Task 1 + Task 3 |
| Seven titled bordered windows as React components | Task 2 |
| Compact grid rows + tall Transactions | Task 3 |
| Empty bodies / no domain logic | Task 2–3 |
| TypeScript typechecks | Task 3 Step 3 |
| No tests / no theme / no top bar | All tasks (omitted) |
