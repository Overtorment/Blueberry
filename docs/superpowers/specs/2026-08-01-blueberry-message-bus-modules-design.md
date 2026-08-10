# blueberry message bus & modules design

Date: 2026-08-01  
Status: approved (conversation)

## Goal

Introduce a modular app core: a typed in-process message bus, injectable centralized storage (swappable backend), and scaffolded worker modules that run concurrently on the JS event loop. The existing OpenTUI dashboard becomes a bus participant and renders from events it receives. Domain logic (P2P, sync, filters, parsing, wallet math) is out of scope for this pass — modules are wired and report status only.

## Decisions

| Topic | Choice |
|-------|--------|
| Concurrency | JS event loop (promises / timers / I/O); no worker threads |
| Inter-module communication | Bus only — modules never import or call each other |
| Storage | Centralized, injected into every module; interface + in-memory impl first |
| Bus API | Typed events only (`on` → unsubscribe, `emit`); no request/response yet |
| Balance | Scaffold a separate Balance/wallet module (not TUI-only) |
| TUI data path | Bus-driven only; TUI does not read storage directly |

## Architecture

```
main
 ├── MessageBus (typed EventMap)
 ├── Storage (interface → MemoryStorage)
 └── modules.start()  (parallel async work via event loop)
      ├── peers-discovery
      ├── chain-headers
      ├── filters-download
      ├── filters-matching
      ├── blocks-download
      ├── parse-blocks
      ├── balance
      └── tui  (subscribes → React state → tiles)
```

**Core pieces**

- `MessageBus` — typed in-process pub/sub; sync dispatch to listeners on `emit`
- `Storage` — interface + in-memory implementation; sole persistence API
- `Module` — `createX({ bus, storage }) → { name, start(), stop() }`
- `main` — constructs bus + storage, creates modules, awaits `start()`, mounts TUI, emits `app:started`

## Project layout

```
src/
  main.tsx                 # wire bus, storage, modules, mount TUI
  bus/
    types.ts               # EventMap: event name → payload
    message-bus.ts         # MessageBus implementation
  storage/
    types.ts               # Storage interface
    memory-storage.ts      # in-memory implementation
  modules/
    types.ts               # Module, ModuleContext
    peers-discovery.ts
    chain-headers.ts
    filters-download.ts
    filters-matching.ts
    blocks-download.ts
    parse-blocks.ts
    balance.ts
  tui/
    App.tsx                # existing grid (moved from src/)
    components/            # existing tiles (moved from src/components/)
    tui-module.ts          # bus participant: subscribe → UI state
```

Existing empty tile components stay; they gain minimal status text from bus events. Paths move under `src/tui/` so domain modules stay separate from presentation.

## Interfaces

```ts
type EventMap = {
  "app:started": { at: number };
  "module:status": {
    module: string;
    status: "starting" | "running" | "stopped" | "error";
    detail?: string;
  };
};

interface MessageBus {
  on<K extends keyof EventMap>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void;
  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void;
}

interface Storage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

interface ModuleContext {
  bus: MessageBus;
  storage: Storage;
}

interface Module {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}
```

`on` returns an unsubscribe function. Domain-specific `Storage` methods may be added later without changing the swap story (new methods on the interface + all implementations).

## Modules (scaffold)

| Module | Responsibility (later) | Scaffold behavior |
|--------|------------------------|-------------------|
| `peers-discovery` | Networking: find/maintain peers | emit status on start/stop |
| `chain-headers` | Headers sync & validation | emit status on start/stop |
| `filters-download` | BIP157/158 filter download | emit status on start/stop |
| `filters-matching` | CPU: match filters to wallet | emit status on start/stop |
| `blocks-download` | Download matched blocks | emit status on start/stop |
| `parse-blocks` | Parse blocks, find txs, unwrap UTXOs | emit status on start/stop |
| `balance` | Wallet balance from UTXOs / related state | emit status on start/stop |
| `tui` | Render dashboard from bus events | subscribe to `module:status` (and later domain events); update tiles |

Each scaffold module registers any listeners in `start`, emits `module:status` (`starting` → `running`), and in `stop` unsubscribes and emits `stopped`.

## Data flow & lifecycle

**Boot**

1. Create `MessageBus` and `MemoryStorage`
2. Create all modules with `{ bus, storage }`
3. Await `start()` for each module in fixed list order (including TUI). `start()` is sequential; after start, modules run concurrently on the event loop.
4. Mount OpenTUI (`createCliRenderer` + `createRoot`); TUI subscriptions are already active from its `start()`
5. Emit `app:started`

**Steady state (future)**

Pipeline is event-driven; modules write durable state through `Storage` and announce progress/results on the bus. Intended flow:

```
PeersDiscovery  → peers:updated       → TUI Peers (+ storage)
ChainHeaders    → headers:tip         → TUI Chain tip (+ storage)
FiltersDownload → filters:progress    → TUI
FiltersMatching → filters:match       → BlocksDownload + TUI
BlocksDownload  → blocks:downloaded   → ParseBlocks + TUI
ParseBlocks     → wallet:utxos        → Balance + TUI Transactions
Balance         → wallet:balance      → TUI Balance
```

This scaffold only defines and emits `module:status` and `app:started`. Domain event keys are added to `EventMap` when those modules are implemented.

**Shutdown**

Ctrl+C → `stop()` each module (unsubscribe handlers) → process exit.

## Error handling

- During `emit`, exceptions from individual handlers are caught and isolated so one subscriber cannot break others
- If a module’s `start()` throws, emit `module:status` with `status: "error"` and a short `detail`; remaining modules continue
- Process-level crash only if `main` fails before the TUI is usable

## Testing

- Unit tests for `MessageBus`: subscribe, emit, unsubscribe, handler-error isolation
- Unit tests for `MemoryStorage`: get / set / delete
- No network or integration tests in this pass

## Success criteria

- `bun start` still launches the seven-tile dashboard
- All listed modules initialize and report status over the bus
- TUI shows minimal status text driven by `module:status` events
- Storage is used only behind the `Storage` interface with the in-memory impl
- `bun run typecheck` passes; bus/storage unit tests pass

## Out of scope

- Real P2P, header sync, filter download/match, block download, parsing, wallet math
- Disk-backed database (SQLite or other) — interface is ready to swap later
- Request/response APIs on the bus
- Direct TUI → storage reads
- Visual theming beyond current bordered tiles
- Moving Balance tile off the TUI or removing tiles
