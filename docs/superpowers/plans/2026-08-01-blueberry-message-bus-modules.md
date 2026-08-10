# blueberry Message Bus & Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a typed in-process message bus, injectable in-memory storage, scaffolded worker modules (including Balance), and wire the OpenTUI dashboard as a bus participant that shows module status.

**Architecture:** `main` constructs `MessageBus` + `MemoryStorage`, creates modules with `{ bus, storage }`, awaits sequential `start()`, mounts the TUI, then emits `app:started`. Modules never import each other; they only use the bus and storage. The TUI module writes `module:status` into a small external store that React tiles read.

**Tech Stack:** Bun, TypeScript, React 19.2, `@opentui/core` / `@opentui/react` ^0.4.5 (existing). No new runtime dependencies.

## Global Constraints

- Follow `docs/superpowers/specs/2026-08-01-blueberry-message-bus-modules-design.md` exactly.
- Bus: typed `EventMap` with only `app:started` and `module:status` in this pass; `on` returns unsubscribe; `emit` isolates handler errors.
- Storage: `Storage` interface + `MemoryStorage` only (no disk DB).
- Modules talk only via the bus; storage is injected, never shared by importing other modules.
- TUI is bus-driven only (no direct storage reads).
- Domain logic (P2P, sync, filters, parsing, wallet math) is out of scope — scaffold status only.
- Do not copy from other codebases.
- Commits: only when the user explicitly asks (skip Commit steps unless asked).
- Keep existing seven-tile layout and titles.

## File structure

| Path | Responsibility |
|------|----------------|
| `src/bus/types.ts` | `EventMap`, `MessageBus` interface |
| `src/bus/message-bus.ts` | `createMessageBus()` implementation |
| `src/storage/types.ts` | `Storage` interface |
| `src/storage/memory-storage.ts` | In-memory `Storage` |
| `src/modules/types.ts` | `Module`, `ModuleContext` |
| `src/modules/scaffold.ts` | Shared status-only module helper |
| `src/modules/peers-discovery.ts` | Scaffold module factory |
| `src/modules/chain-headers.ts` | Scaffold module factory |
| `src/modules/filters-download.ts` | Scaffold module factory |
| `src/modules/filters-matching.ts` | Scaffold module factory |
| `src/modules/blocks-download.ts` | Scaffold module factory |
| `src/modules/parse-blocks.ts` | Scaffold module factory |
| `src/modules/balance.ts` | Scaffold module factory |
| `src/tui/status-store.ts` | External store for module statuses |
| `src/tui/use-module-status.ts` | React hook over status store |
| `src/tui/tui-module.ts` | TUI bus participant |
| `src/tui/App.tsx` | Grid (moved from `src/App.tsx`) |
| `src/tui/components/*.tsx` | Tiles (moved); show status text |
| `src/main.tsx` | Wire bus, storage, modules, mount TUI, shutdown |
| `tests/message-bus.test.ts` | Bus unit tests |
| `tests/memory-storage.test.ts` | Storage unit tests |

Delete after move: `src/App.tsx`, `src/components/*.tsx`.

---

### Task 1: MessageBus (TDD)

**Files:**
- Create: `src/bus/types.ts`
- Create: `src/bus/message-bus.ts`
- Test: `tests/message-bus.test.ts`
- Modify: `package.json` (add `"test": "bun test"`)
- Modify: `tsconfig.json` (`include` → `["src", "tests"]`)

**Interfaces:**
- Consumes: none
- Produces: `EventMap`; `MessageBus` with `on` / `emit`; `createMessageBus(): MessageBus`

- [ ] **Step 1: Add test script and tsconfig include**

In `package.json`, add script `"test": "bun test"`.

In `tsconfig.json`, set `"include": ["src", "tests"]`.

- [ ] **Step 2: Write failing bus tests**

Create `tests/message-bus.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createMessageBus } from "../src/bus/message-bus.ts";

describe("MessageBus", () => {
  test("delivers payload to subscribers", () => {
    const bus = createMessageBus();
    const seen: unknown[] = [];
    bus.on("app:started", (p) => seen.push(p));
    bus.emit("app:started", { at: 42 });
    expect(seen).toEqual([{ at: 42 }]);
  });

  test("unsubscribe stops delivery", () => {
    const bus = createMessageBus();
    let count = 0;
    const off = bus.on("module:status", () => {
      count++;
    });
    bus.emit("module:status", {
      module: "x",
      status: "running",
    });
    off();
    bus.emit("module:status", {
      module: "x",
      status: "stopped",
    });
    expect(count).toBe(1);
  });

  test("handler errors do not block other listeners", () => {
    const bus = createMessageBus();
    const seen: string[] = [];
    bus.on("app:started", () => {
      throw new Error("boom");
    });
    bus.on("app:started", (p) => {
      seen.push(String(p.at));
    });
    expect(() => bus.emit("app:started", { at: 1 })).not.toThrow();
    expect(seen).toEqual(["1"]);
  });
});
```

- [ ] **Step 3: Run tests — expect FAIL**

Run:

```bash
bun test tests/message-bus.test.ts
```

Expected: FAIL (module not found / cannot resolve `createMessageBus`).

- [ ] **Step 4: Implement bus types + MessageBus**

Create `src/bus/types.ts`:

```ts
export type ModuleStatus = "starting" | "running" | "stopped" | "error";

export type EventMap = {
  "app:started": { at: number };
  "module:status": {
    module: string;
    status: ModuleStatus;
    detail?: string;
  };
};

export interface MessageBus {
  on<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void;
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
}
```

Create `src/bus/message-bus.ts`:

```ts
import type { EventMap, MessageBus } from "./types.ts";

type Handler<K extends keyof EventMap> = (payload: EventMap[K]) => void;

export function createMessageBus(): MessageBus {
  const listeners = new Map<keyof EventMap, Set<Handler<keyof EventMap>>>();

  return {
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler as Handler<keyof EventMap>);
      return () => {
        set!.delete(handler as Handler<keyof EventMap>);
      };
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          (handler as (p: typeof payload) => void)(payload);
        } catch {
          // isolate subscriber failures
        }
      }
    },
  };
}
```

- [ ] **Step 5: Run tests — expect PASS**

Run:

```bash
bun test tests/message-bus.test.ts
```

Expected: 3 pass.

- [ ] **Step 6: Commit (only if user asked)**

```bash
git add package.json tsconfig.json src/bus tests/message-bus.test.ts
git commit -m "$(cat <<'EOF'
Add typed in-process message bus.

EOF
)"
```

---

### Task 2: Storage interface + MemoryStorage (TDD)

**Files:**
- Create: `src/storage/types.ts`
- Create: `src/storage/memory-storage.ts`
- Test: `tests/memory-storage.test.ts`

**Interfaces:**
- Consumes: none
- Produces: `Storage`; `createMemoryStorage(): Storage` with `get` / `set` / `delete`

- [ ] **Step 1: Write failing storage tests**

Create `tests/memory-storage.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createMemoryStorage } from "../src/storage/memory-storage.ts";

describe("MemoryStorage", () => {
  test("get returns undefined for missing key", async () => {
    const storage = createMemoryStorage();
    expect(await storage.get("missing")).toBeUndefined();
  });

  test("set then get round-trips", async () => {
    const storage = createMemoryStorage();
    await storage.set("k", { n: 1 });
    expect(await storage.get<{ n: number }>("k")).toEqual({ n: 1 });
  });

  test("delete removes key", async () => {
    const storage = createMemoryStorage();
    await storage.set("k", "v");
    await storage.delete("k");
    expect(await storage.get("k")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run:

```bash
bun test tests/memory-storage.test.ts
```

Expected: FAIL (cannot resolve `createMemoryStorage`).

- [ ] **Step 3: Implement Storage + MemoryStorage**

Create `src/storage/types.ts`:

```ts
export interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Create `src/storage/memory-storage.ts`:

```ts
import type { Storage } from "./types.ts";

export function createMemoryStorage(): Storage {
  const map = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      if (!map.has(key)) return undefined;
      return map.get(key) as T;
    },
    async set<T = unknown>(key: string, value: T): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  };
}
```

- [ ] **Step 4: Run tests — expect PASS**

Run:

```bash
bun test tests/memory-storage.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/storage tests/memory-storage.test.ts
git commit -m "$(cat <<'EOF'
Add swappable Storage interface with in-memory impl.

EOF
)"
```

---

### Task 3: Module types + scaffold domain modules

**Files:**
- Create: `src/modules/types.ts`
- Create: `src/modules/scaffold.ts`
- Create: `src/modules/peers-discovery.ts`
- Create: `src/modules/chain-headers.ts`
- Create: `src/modules/filters-download.ts`
- Create: `src/modules/filters-matching.ts`
- Create: `src/modules/blocks-download.ts`
- Create: `src/modules/parse-blocks.ts`
- Create: `src/modules/balance.ts`

**Interfaces:**
- Consumes: `MessageBus` from `src/bus/types.ts`; `Storage` from `src/storage/types.ts`
- Produces: `Module`, `ModuleContext`; `createScaffoldModule(name, ctx): Module`; seven `create*Module(ctx): Module` factories

- [ ] **Step 1: Write module types + scaffold helper**

Create `src/modules/types.ts`:

```ts
import type { MessageBus } from "../bus/types.ts";
import type { Storage } from "../storage/types.ts";

export interface ModuleContext {
  bus: MessageBus;
  storage: Storage;
}

export interface Module {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}
```

Create `src/modules/scaffold.ts`:

```ts
import type { Module, ModuleContext } from "./types.ts";

export function createScaffoldModule(
  name: string,
  ctx: ModuleContext,
): Module {
  return {
    name,
    start() {
      ctx.bus.emit("module:status", { module: name, status: "starting" });
      ctx.bus.emit("module:status", { module: name, status: "running" });
    },
    stop() {
      ctx.bus.emit("module:status", { module: name, status: "stopped" });
    },
  };
}
```

- [ ] **Step 2: Write seven domain module factories**

Create `src/modules/peers-discovery.ts`:

```ts
import { createScaffoldModule } from "./scaffold.ts";
import type { Module, ModuleContext } from "./types.ts";

export function createPeersDiscoveryModule(ctx: ModuleContext): Module {
  return createScaffoldModule("peers-discovery", ctx);
}
```

Create `src/modules/chain-headers.ts`:

```ts
import { createScaffoldModule } from "./scaffold.ts";
import type { Module, ModuleContext } from "./types.ts";

export function createChainHeadersModule(ctx: ModuleContext): Module {
  return createScaffoldModule("chain-headers", ctx);
}
```

Create `src/modules/filters-download.ts`:

```ts
import { createScaffoldModule } from "./scaffold.ts";
import type { Module, ModuleContext } from "./types.ts";

export function createFiltersDownloadModule(ctx: ModuleContext): Module {
  return createScaffoldModule("filters-download", ctx);
}
```

Create `src/modules/filters-matching.ts`:

```ts
import { createScaffoldModule } from "./scaffold.ts";
import type { Module, ModuleContext } from "./types.ts";

export function createFiltersMatchingModule(ctx: ModuleContext): Module {
  return createScaffoldModule("filters-matching", ctx);
}
```

Create `src/modules/blocks-download.ts`:

```ts
import { createScaffoldModule } from "./scaffold.ts";
import type { Module, ModuleContext } from "./types.ts";

export function createBlocksDownloadModule(ctx: ModuleContext): Module {
  return createScaffoldModule("blocks-download", ctx);
}
```

Create `src/modules/parse-blocks.ts`:

```ts
import { createScaffoldModule } from "./scaffold.ts";
import type { Module, ModuleContext } from "./types.ts";

export function createParseBlocksModule(ctx: ModuleContext): Module {
  return createScaffoldModule("parse-blocks", ctx);
}
```

Create `src/modules/balance.ts`:

```ts
import { createScaffoldModule } from "./scaffold.ts";
import type { Module, ModuleContext } from "./types.ts";

export function createBalanceModule(ctx: ModuleContext): Module {
  return createScaffoldModule("balance", ctx);
}
```

- [ ] **Step 3: Smoke-check factories via bun**

Run:

```bash
bun -e '
import { createMessageBus } from "./src/bus/message-bus.ts";
import { createMemoryStorage } from "./src/storage/memory-storage.ts";
import { createPeersDiscoveryModule } from "./src/modules/peers-discovery.ts";
import { createBalanceModule } from "./src/modules/balance.ts";
const bus = createMessageBus();
const storage = createMemoryStorage();
const statuses: string[] = [];
bus.on("module:status", (p) => statuses.push(`${p.module}:${p.status}`));
const ctx = { bus, storage };
createPeersDiscoveryModule(ctx).start();
createBalanceModule(ctx).start();
if (!statuses.includes("peers-discovery:running") || !statuses.includes("balance:running")) {
  console.error(statuses);
  process.exit(1);
}
console.log("ok");
'
```

Expected: prints `ok`.

- [ ] **Step 4: Commit (only if user asked)**

```bash
git add src/modules
git commit -m "$(cat <<'EOF'
Scaffold domain modules on shared status helper.

EOF
)"
```

---

### Task 4: Move TUI under `src/tui/`, status store, TUI module, status in tiles

**Files:**
- Create: `src/tui/status-store.ts`
- Create: `src/tui/use-module-status.ts`
- Create: `src/tui/tui-module.ts`
- Create: `src/tui/App.tsx` (from `src/App.tsx`, update imports)
- Create: `src/tui/components/*.tsx` (from `src/components/*.tsx`, add status text)
- Delete: `src/App.tsx`, `src/components/*.tsx`

**Interfaces:**
- Consumes: `MessageBus`, `Module` / `ModuleContext`, `module:status` events
- Produces: `createModuleStatusStore()`; `createTuiModule(ctx, store): Module`; `useModuleStatus(moduleName): string`; updated tile components

Tile → module name mapping:

| Tile component | Listens for `module` |
|----------------|----------------------|
| `Balance` | `balance` |
| `ChainTipSync` | `chain-headers` |
| `Peers` | `peers-discovery` |
| `FiltersDownload` | `filters-download` |
| `FiltersMatching` | `filters-matching` |
| `BlocksDownload` | `blocks-download` |
| `Transactions` | `parse-blocks` |

- [ ] **Step 1: Create status store**

Create `src/tui/status-store.ts`:

```ts
import type { ModuleStatus } from "../bus/types.ts";

export type ModuleStatusEntry = {
  status: ModuleStatus;
  detail?: string;
};

export type ModuleStatusStore = {
  get(module: string): ModuleStatusEntry | undefined;
  set(module: string, entry: ModuleStatusEntry): void;
  subscribe(listener: () => void): () => void;
};

export function createModuleStatusStore(): ModuleStatusStore {
  const map = new Map<string, ModuleStatusEntry>();
  const listeners = new Set<() => void>();

  return {
    get(module) {
      return map.get(module);
    },
    set(module, entry) {
      map.set(module, entry);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
```

- [ ] **Step 2: Create React hook**

Create `src/tui/use-module-status.ts`:

```ts
import { useSyncExternalStore } from "react";
import type { ModuleStatusStore } from "./status-store.ts";

let activeStore: ModuleStatusStore | null = null;

export function setActiveStatusStore(store: ModuleStatusStore): void {
  activeStore = store;
}

export function useModuleStatus(moduleName: string): string {
  const store = activeStore;
  const entry = useSyncExternalStore(
    (onChange) => (store ? store.subscribe(onChange) : () => {}),
    () => store?.get(moduleName),
    () => store?.get(moduleName),
  );
  if (!entry) return "idle";
  return entry.detail ? `${entry.status}: ${entry.detail}` : entry.status;
}
```

- [ ] **Step 3: Create TUI module**

Create `src/tui/tui-module.ts`:

```ts
import type { Module, ModuleContext } from "../modules/types.ts";
import type { ModuleStatusStore } from "./status-store.ts";

export function createTuiModule(
  ctx: ModuleContext,
  store: ModuleStatusStore,
): Module {
  let unsubscribe: (() => void) | undefined;

  return {
    name: "tui",
    start() {
      unsubscribe = ctx.bus.on("module:status", (payload) => {
        store.set(payload.module, {
          status: payload.status,
          detail: payload.detail,
        });
      });
      ctx.bus.emit("module:status", { module: "tui", status: "starting" });
      ctx.bus.emit("module:status", { module: "tui", status: "running" });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      ctx.bus.emit("module:status", { module: "tui", status: "stopped" });
    },
  };
}
```

Note: TUI must be started **before** other modules if you want every `module:status` captured — but the design says fixed list order with TUI included. Start **TUI first** in `main` (Task 5) so its listener is registered before domain modules emit. Document that in Task 5; keep `createTuiModule` as above.

- [ ] **Step 4: Move App and components; show status**

Move `src/App.tsx` → `src/tui/App.tsx` and fix imports to `./components/...`.

Move each file from `src/components/` → `src/tui/components/`.

Update each tile to show status. Example `src/tui/components/Peers.tsx`:

```tsx
import { useModuleStatus } from "../use-module-status.ts";

export function Peers() {
  const status = useModuleStatus("peers-discovery");
  return (
    <box
      title="Peers"
      border
      borderStyle="single"
      flexGrow={1}
      height="100%"
      flexDirection="column"
      padding={1}
    >
      <text>{status}</text>
    </box>
  );
}
```

Apply the same pattern to all tiles with the mapping table above (`Balance` → `"balance"`, `ChainTipSync` → `"chain-headers"`, `FiltersDownload` → `"filters-download"`, `FiltersMatching` → `"filters-matching"`, `BlocksDownload` → `"blocks-download"`, `Transactions` → `"parse-blocks"`).

`src/tui/App.tsx` stays the same grid as today; only import paths change:

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

Delete `src/App.tsx` and `src/components/` after the move.

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/tui
git add -u src/App.tsx src/components
git commit -m "$(cat <<'EOF'
Move TUI under src/tui and bind tiles to bus status.

EOF
)"
```

---

### Task 5: Wire `main.tsx` (boot, start order, shutdown)

**Files:**
- Modify: `src/main.tsx`

**Interfaces:**
- Consumes: `createMessageBus`, `createMemoryStorage`, all module factories, `createTuiModule`, `createModuleStatusStore`, `setActiveStatusStore`, `App`
- Produces: runnable app — bus + storage + modules started, TUI mounted, `app:started` emitted, SIGINT/SIGTERM stops modules

- [ ] **Step 1: Rewrite `src/main.tsx`**

```tsx
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createMessageBus } from "./bus/message-bus.ts";
import { createBalanceModule } from "./modules/balance.ts";
import { createBlocksDownloadModule } from "./modules/blocks-download.ts";
import { createChainHeadersModule } from "./modules/chain-headers.ts";
import { createFiltersDownloadModule } from "./modules/filters-download.ts";
import { createFiltersMatchingModule } from "./modules/filters-matching.ts";
import { createParseBlocksModule } from "./modules/parse-blocks.ts";
import { createPeersDiscoveryModule } from "./modules/peers-discovery.ts";
import type { Module } from "./modules/types.ts";
import { createMemoryStorage } from "./storage/memory-storage.ts";
import { App } from "./tui/App.tsx";
import { createModuleStatusStore } from "./tui/status-store.ts";
import { createTuiModule } from "./tui/tui-module.ts";
import { setActiveStatusStore } from "./tui/use-module-status.ts";

const bus = createMessageBus();
const storage = createMemoryStorage();
const ctx = { bus, storage };
const statusStore = createModuleStatusStore();
setActiveStatusStore(statusStore);

const modules: Module[] = [
  createTuiModule(ctx, statusStore),
  createPeersDiscoveryModule(ctx),
  createChainHeadersModule(ctx),
  createFiltersDownloadModule(ctx),
  createFiltersMatchingModule(ctx),
  createBlocksDownloadModule(ctx),
  createParseBlocksModule(ctx),
  createBalanceModule(ctx),
];

async function startModules(): Promise<void> {
  for (const mod of modules) {
    try {
      await mod.start();
    } catch (err) {
      bus.emit("module:status", {
        module: mod.name,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function stopModules(): Promise<void> {
  for (const mod of [...modules].reverse()) {
    try {
      await mod.stop();
    } catch {
      // ignore stop errors during shutdown
    }
  }
}

await startModules();

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
});

createRoot(renderer).render(<App />);

bus.emit("app:started", { at: Date.now() });

async function shutdown(): Promise<void> {
  await stopModules();
  renderer.destroy();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
```

TUI is first in the list so it receives every subsequent `module:status`.

- [ ] **Step 2: Typecheck**

Run:

```bash
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run all unit tests**

Run:

```bash
bun test
```

Expected: all bus + storage tests pass.

- [ ] **Step 4: Manual smoke check**

Run:

```bash
bun start
```

Expected:
- Same seven-tile layout
- Each relevant tile shows `running` (or similar status text from the bus)
- Ctrl+C exits cleanly

- [ ] **Step 5: Commit (only if user asked)**

```bash
git add src/main.tsx
git commit -m "$(cat <<'EOF'
Wire main to bus, storage, modules, and TUI lifecycle.

EOF
)"
```

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Typed MessageBus (`on` / `emit`, error isolation) | Task 1 |
| Storage interface + MemoryStorage | Task 2 |
| ModuleContext / Module + seven domain scaffolds | Task 3 |
| Balance module scaffold | Task 3 |
| TUI under `src/tui/`, bus participant, status in tiles | Task 4 |
| main wires bus/storage/modules, `app:started`, shutdown | Task 5 |
| Bus-only inter-module; storage injected | Tasks 3–5 |
| Unit tests for bus + storage | Tasks 1–2 |
| `bun start` dashboard + typecheck | Task 5 |
| No domain networking/CPU logic | All (scaffold only) |
| No request/response; no disk DB; no TUI→storage | All (omitted) |
