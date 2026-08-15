# Debug file log (`--log`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the existing file log only when argv has `--log`, and write scoped lines for important boot, sync, wallet, and send events.

**Architecture:** Keep `src/log.ts` as the only write path. `shouldEnableFileLog(argv)` gates `initFileLog` in `main.tsx`. Modules call `log("scope", message)` / `logError`. Do not add a Logger type or pass a logger into every module. Optional `log` callbacks stay only on `blocks-download` and `filters-download`.

**Tech Stack:** Bun, TypeScript, existing `src/log.ts`. No new npm packages.

**Spec:** `docs/superpowers/specs/2026-08-15-blueberry-debug-file-log-design.md`

## Global Constraints

- Enable only on an exact `--log` argv token. `--log=1` and `--logs` are off.
- Log path stays `./blueberry.data/blueberry.log`. Line format stays `ISO [scope] message`.
- Do not add log levels, JSON logs, rotation, stdout mirroring, or `--log <path>`.
- Do not log mnemonic, WIF, `wallet_secret`, raw PSBT, or full transaction hex.
- Do not add `log?:` to module options except the two download modules that already have it.
- Skip Commit steps unless the user asks to commit.

## File structure

| File | Responsibility |
|------|----------------|
| `src/log.ts` | Add `shouldEnableFileLog(argv)` |
| `src/main.tsx` | Gate `initFileLog`; boot / onboarding / startApp / shutdown / module-start-fail lines |
| `src/modules/sync-idle.ts` | idle / catchup lines |
| `src/modules/peers-discovery.ts` | start/stop, pause/resume, DNS, probe fail |
| `src/modules/chain-headers.ts` | start/stop, apply/rewind, peer fail, wait, at-tip |
| `src/modules/parse-blocks.ts` | start/stop, allow/pause, batch, decode error |
| `src/modules/filters-matching.ts` | start/stop, scan start/done, rematch |
| `src/wallet/wallet.ts` | ready + gap-grew (counts only) |
| `src/wallet/birthday.ts` | pending + freeze height |
| `src/tui/ui-route-store.ts` | route changes |
| `src/tui/broadcast-actions.ts` | broadcast start/cancel (id only) |
| `tests/unit/file-log-harness.ts` | temp file + `initFileLog` / `closeFileLog` |
| `tests/unit/log.test.ts` | gate + silent-when-unset |
| existing module tests | assert new lines with the harness |

No change: `filters-download`, `blocks-download`, `broadcast` (already log). `reexecSelf` already forwards argv.

---

### Task 1: Gate `--log` and boot lines

**Files:**
- Modify: `src/log.ts`
- Modify: `src/main.tsx`
- Create: `tests/unit/file-log-harness.ts`
- Test: `tests/unit/log.test.ts`

**Interfaces:**
- Consumes: existing `initFileLog` / `closeFileLog` / `getLogPath` / `log` / `logError`
- Produces:

```ts
export function shouldEnableFileLog(argv: readonly string[]): boolean;
```

```ts
// tests/unit/file-log-harness.ts
export function openTempFileLog(): { read(): string; close(): void };
```

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/log.test.ts` (keep the existing "appends scoped lines" test):

```ts
import { existsSync } from "node:fs";
import { shouldEnableFileLog } from "../../src/log.ts";

test("shouldEnableFileLog is true only for an exact --log token", () => {
  expect(shouldEnableFileLog([])).toBe(false);
  expect(shouldEnableFileLog(["--logs"])).toBe(false);
  expect(shouldEnableFileLog(["--log=1"])).toBe(false);
  expect(shouldEnableFileLog(["--log"])).toBe(true);
  expect(shouldEnableFileLog(["bun", "src/main.tsx", "--log"])).toBe(true);
});

test("log is silent when the file is not opened", () => {
  dir = mkdtempSync(join(tmpdir(), "blueberry-log-"));
  const path = join(dir, "blueberry.log");
  expect(getLogPath()).toBeNull();
  log("main", "nope");
  logError("main", "nope", new Error("x"));
  expect(existsSync(path)).toBe(false);
});
```

Create `tests/unit/file-log-harness.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeFileLog, initFileLog } from "../../src/log.ts";

export function openTempFileLog(): { read(): string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), "blueberry-log-"));
  const path = join(dir, "blueberry.log");
  initFileLog(path);
  return {
    read: () => readFileSync(path, "utf8"),
    close: () => {
      closeFileLog();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/log.test.ts`

Expected: FAIL — `shouldEnableFileLog` is not exported.

- [ ] **Step 3: Implement the gate and main boot lines**

Add to `src/log.ts` (do not change `initFileLog` / `log` / line format):

```ts
/** True only when argv contains the exact token `--log`. */
export function shouldEnableFileLog(argv: readonly string[]): boolean {
  return argv.includes("--log");
}
```

In `src/main.tsx`, replace the unconditional init:

```ts
import { initFileLog, log, logError, shouldEnableFileLog } from "./log.ts";

mkdirSync("./blueberry.data", { recursive: true });
if (shouldEnableFileLog(process.argv)) {
  initFileLog("./blueberry.data/blueberry.log");
}
log("main", "boot");
```

After `resolveOnboardingGate`:

```ts
  if (gate.action === "exit-invalid") {
    log("main", `exit-invalid ${gate.detail}`);
    console.error(`wallet_secret is present but invalid: ${gate.detail}`);
    console.error(
      "Fix or delete the wallet_secret key in the database, then restart.",
    );
    process.reallyExit(1);
  }

  if (gate.action === "onboard") {
    log("main", "onboarding");
    // ... existing onboarding renderer ...
```

In `quitOnboarding`, before `reallyExit`:

```ts
      log("main", `onboarding quit code=${code}`);
```

In the `else` branch:

```ts
  } else {
    log("main", "startApp");
    await startApp(db);
  }
```

In `startApp`, after `loadSyncFromYear`:

```ts
  const year = loadSyncFromYear(db);
  log("main", `startApp year=${year}`);
```

In `startModule` catch:

```ts
    } catch (err) {
      logError("main", `module start failed name=${mod.name}`, err);
      bus.emit("module:status", {
        module: mod.name,
        status: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
```

In `shutdown`, before `reallyExit`:

```ts
    log("main", "shutdown");
    process.reallyExit(0);
```

Do not log wallet secrets or onboarding mnemonic text.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/log.test.ts`

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/log.ts src/main.tsx tests/unit/log.test.ts tests/unit/file-log-harness.ts
git commit -m "feat: open the file log only when argv has --log."
```

---

### Task 2: `sync-idle` transitions

**Files:**
- Modify: `src/modules/sync-idle.ts`
- Test: `tests/unit/sync-idle.test.ts`

**Interfaces:**
- Consumes: `log(scope, message)` from `src/log.ts`
- Produces: lines `[sync-idle] start`, `[sync-idle] idle`, `[sync-idle] catchup reason=blocks`, `[sync-idle] stop`

- [ ] **Step 1: Write the failing test**

Add imports at the top of `tests/unit/sync-idle.test.ts`:

```ts
import { openTempFileLog } from "./file-log-harness.ts";
```

Add this test after `"needs two idle evals; then emits once (no re-spam)"`:

```ts
  test("logs idle and catchup transitions", async () => {
    const file = openTempFileLog();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const tip = seedCaughtUpDb(db);
    const idles: number[] = [];
    const catchups: string[] = [];
    bus.on("sync:idle", (p) => idles.push(p.at));
    bus.on("sync:catchup", (p) => catchups.push(p.reason));

    const mod = createSyncIdleModule(
      { bus, db },
      { evalIntervalMs: 10_000, minAliveCompactFilters: 1 },
    );
    await mod.start();
    enterIdle(bus);
    await waitFor(() => idles.length >= 1);

    db.matchedBlocks.insert({
      height: tip.height,
      blockHashInternalHex: tip.hashInternalHex,
    });
    bus.emit("filters:match", {
      height: tip.height,
      blockHashInternalHex: tip.hashInternalHex,
    });
    await waitFor(() => catchups.includes("blocks"));
    await mod.stop();

    const text = file.read();
    file.close();
    db.close();
    expect(text).toContain("[sync-idle] start");
    expect(text).toContain("[sync-idle] idle");
    expect(text).toContain("[sync-idle] catchup reason=blocks");
    expect(text).toContain("[sync-idle] stop");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/sync-idle.test.ts --test-name-pattern 'logs idle'`

Expected: FAIL — file has no `[sync-idle]` lines.

- [ ] **Step 3: Add the log calls**

In `src/modules/sync-idle.ts`:

```ts
import { log } from "../log.ts";
```

In `applyEvaluation`, when emitting idle:

```ts
        mode = "idle";
        log("sync-idle", "idle");
        ctx.bus.emit("sync:idle", { at: now() });
```

When emitting catchup:

```ts
      mode = "catchup";
      log("sync-idle", `catchup reason=${evalResult.reason}`);
      ctx.bus.emit("sync:catchup", {
        at: now(),
        reason: evalResult.reason,
      });
```

In `start()`, after `stopped = false`:

```ts
      log("sync-idle", "start");
```

In `stop()`, before the status emit:

```ts
      log("sync-idle", "stop");
```

Do not log every `evaluate()` tick.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/sync-idle.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/sync-idle.ts tests/unit/sync-idle.test.ts
git commit -m "feat: log sync-idle start, stop, and mode changes."
```

---

### Task 3: `peers-discovery` pool events

**Files:**
- Modify: `src/modules/peers-discovery.ts`
- Test: `tests/unit/peers-discovery.test.ts`

**Interfaces:**
- Consumes: `log` / `logError` from `src/log.ts`
- Produces: `[peers-discovery] start|stop|pause|resume`, `dns seeds=N`, `dns` errors, `probe fail host:port error=...`

- [ ] **Step 1: Write the failing tests**

Add import:

```ts
import { openTempFileLog } from "./file-log-harness.ts";
```

Add after `"DNS bootstrap inserts seed peers and emits peers:updated"`:

```ts
  test("logs DNS seed count", async () => {
    const file = openTempFileLog();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [
          { host: "10.0.0.1", port: 8333, services: 0n },
          { host: "10.0.0.2", port: 8333, services: 0n },
        ],
        probe: async () => ({ ok: false, error: "skip" }),
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    await waitFor(() => db.peers.count() === 2);
    await mod.stop();
    const text = file.read();
    file.close();
    db.close();
    expect(text).toContain("[peers-discovery] start");
    expect(text).toContain("[peers-discovery] dns seeds=2");
    expect(text).toContain("[peers-discovery] stop");
  });
```

Add after `"failed probe updates lastProbedAt and clears alive"`:

```ts
  test("logs probe fail with host", async () => {
    const file = openTempFileLog();
    const bus = createMessageBus();
    const db = createSqliteDatabase(":memory:");
    db.peers.upsert({
      host: "9.9.9.9",
      port: 8333,
      services: 0n,
      alive: false,
      usedForBlocks: false,
      lastProbedAt: null,
    });
    const mod = createPeersDiscoveryModule(
      { bus, db },
      {
        net: stubPlatformNet(),
        resolveSeeds: async () => [],
        probe: async () => ({ ok: false, error: "timeout" }),
        concurrency: 1,
        idleDelayMs: 50,
        minAliveCompactFilters: 0,
      },
    );
    await mod.start();
    await waitFor(() => db.peers.list()[0]?.lastProbedAt !== null);
    await mod.stop();
    const text = file.read();
    file.close();
    db.close();
    expect(text).toContain("[peers-discovery] probe fail 9.9.9.9:8333 error=timeout");
  });
```

In `"sync:idle pauses probes; sync:catchup resumes"`, open a temp log at the start and assert after stop:

```ts
    const file = openTempFileLog();
    // ... existing body ...
    await mod.stop();
    const text = file.read();
    file.close();
    expect(text).toContain("[peers-discovery] pause");
    expect(text).toContain("[peers-discovery] resume");
    db.close();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/peers-discovery.test.ts --test-name-pattern 'logs DNS|logs probe|pauses probes'`

Expected: FAIL — missing `[peers-discovery]` lines.

- [ ] **Step 3: Add the log calls**

In `src/modules/peers-discovery.ts`:

```ts
import { log, logError } from "../log.ts";
```

`refreshPause`:

```ts
    if (wantPause === paused) return;
    paused = wantPause;
    log("peers-discovery", paused ? "pause" : "resume");
    kick();
```

`pullSeeds` success / fail:

```ts
      const seeds = await resolveSeeds();
      if (stopped || paused) return;
      log("peers-discovery", `dns seeds=${seeds.length}`);
      for (const candidate of seeds) upsertCandidate(candidate);
      // ... existing emit/kick ...
    } catch (err) {
      logError("peers-discovery", "dns", err);
    } finally {
```

Probe `ok: false` (do not log successful probes):

```ts
            } else {
              log(
                "peers-discovery",
                `probe fail ${key} error=${result.error}`,
              );
              ctx.db.peers.markAlive(next.host, next.port, false);
            }
```

Probe `catch`:

```ts
          } catch (err) {
            if (stopped) return;
            logError("peers-discovery", `probe fail ${key}`, err);
            ctx.db.peers.markProbed(next.host, next.port, now());
            ctx.db.peers.markAlive(next.host, next.port, false);
            emitUpdated();
```

`start` / `stop`:

```ts
      log("peers-discovery", "start");
      // ... existing start body ...
```

```ts
      log("peers-discovery", "stop");
      // existing status stopped emit
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/peers-discovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/peers-discovery.ts tests/unit/peers-discovery.test.ts
git commit -m "feat: log peer DNS, probe fails, and pause/resume."
```

---

### Task 4: `chain-headers` apply, rewind, peer fail

**Files:**
- Modify: `src/modules/chain-headers.ts`
- Test: `tests/unit/chain-headers.test.ts`

**Interfaces:**
- Consumes: `log` / `logError` from `src/log.ts`
- Produces:

```
[chain-headers] start
[chain-headers] append after=<h> tip=<h> n=<n>
[chain-headers] replace after=<h> tip=<h> n=<n>
[chain-headers] peer fail <host:port> error=<msg>
[chain-headers] waiting for peers
[chain-headers] at tip height=<h>
[chain-headers] stop
```

- [ ] **Step 1: Write the failing tests**

Add import:

```ts
import { openTempFileLog } from "./file-log-harness.ts";
```

In `"waits for peers, appends a real mainnet header, emits progress"`, open a temp log before `mod.start()` and after `mod.stop()` assert:

```ts
    const file = openTempFileLog();
    // ... existing body through await mod.stop() ...
    const text = file.read();
    file.close();
    expect(text).toContain("[chain-headers] start");
    expect(text).toContain("[chain-headers] waiting for peers");
    expect(text).toContain(
      `[chain-headers] append after=${CHECKPOINT_HEIGHT} tip=${CHECKPOINT_HEIGHT + 1} n=1`,
    );
    expect(text).toContain(`[chain-headers] at tip height=${CHECKPOINT_HEIGHT + 1}`);
    expect(text).toContain("[chain-headers] stop");
```

In `"hard fetch failure tries peers, marks them not alive, emits peers:updated"`, add `const file = openTempFileLog();` before `mod.start()`. After `await mod.stop()` and before `db.close()`:

```ts
    const text = file.read();
    file.close();
    expect(text).toContain("[chain-headers] peer fail 1.1.1.1:8333 error=dead");
    expect(text).toContain("[chain-headers] peer fail 2.2.2.2:8333 error=dead");
```

That test's `fetchBatch` already returns `{ ok: false, error: "dead" }`.

In `"reorgs to a heavier fork via the sync loop"`, add `const file = openTempFileLog();` before `mod.start()`. After `await mod.stop()` and before `db.close()`:

```ts
    expect(file.read()).toContain("[chain-headers] replace after=");
    file.close();
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/chain-headers.test.ts --test-name-pattern 'waits for peers|hard fetch failure|reorgs to a heavier'`

Expected: FAIL — missing `[chain-headers]` lines.

- [ ] **Step 3: Add the log calls**

In `src/modules/chain-headers.ts`:

```ts
import { log, logError } from "../log.ts";
```

At the end of `persistBranch`, after writes land:

```ts
  const tipHeight = writes[writes.length - 1]!.height;
  log(
    "chain-headers",
    `${mode} after=${ancestorHeight} tip=${tipHeight} n=${writes.length}`,
  );
```

In `raceHeaderFetch`, when `result.ok` is false and the error is not `SESSION_BUSY_ERROR`:

```ts
            log(
              "chain-headers",
              `peer fail ${peerKey(peer.host, peer.port)} error=${result.error}`,
            );
            hardFails++;
            failed.push(peer);
```

Change the rejection handler from `() => {` to `(err) => {` and log:

```ts
          (err) => {
            if (settled) return;
            logError(
              "chain-headers",
              `peer fail ${peerKey(peer.host, peer.port)}`,
              err,
            );
            hardFails++;
            failed.push(peer);
            onSettledPeer();
          },
```

In `runLoop`, dedup "waiting for peers" and "at tip":

```ts
  let loggedWaiting = false;
  let loggedTipHeight = -1;
```

When `alive.length === 0`:

```ts
      if (alive.length === 0) {
        if (!loggedWaiting) {
          loggedWaiting = true;
          log("chain-headers", "waiting for peers");
        }
        waitingForPeers = true;
        // ... existing wait ...
```

When `alive.length > 0`, set `loggedWaiting = false` before picking peers.

On empty header batch (existing `result.headers.length === 0` path), after `emitProgress()`:

```ts
        const tipHeight = ensureChain().tipHeight;
        if (loggedTipHeight !== tipHeight) {
          loggedTipHeight = tipHeight;
          log("chain-headers", `at tip height=${tipHeight}`);
        }
```

`start` / `stop`:

```ts
      log("chain-headers", "start");
```

```ts
      log("chain-headers", "stop");
```

Do not log every locator hash or header byte.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/chain-headers.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/chain-headers.ts tests/unit/chain-headers.test.ts
git commit -m "feat: log header apply, rewind, and peer failures."
```

---

### Task 5: `parse-blocks` and `filters-matching`

**Files:**
- Modify: `src/modules/parse-blocks.ts`
- Modify: `src/modules/filters-matching.ts`
- Test: `tests/unit/parse-blocks.test.ts`
- Test: `tests/unit/filters-matching.test.ts`

**Interfaces:**
- Consumes: `log` / `logError` from `src/log.ts`
- Produces:

```
[parse-blocks] start|stop|allowed|paused
[parse-blocks] batch n=<n> from=<h> to=<h>
[parse-blocks] decode height=<h>: <error>
[filters-matching] start|stop
[filters-matching] scan start scanned=<s> total=<t> external=<e> internal=<i>
[filters-matching] scan done scanned=<s> total=<t> matches=<n>
[filters-matching] rematch from=<h> external=<e> internal=<i>
```

- [ ] **Step 1: Write the failing tests**

In `tests/unit/parse-blocks.test.ts`, import the harness.

In `"parses backlog after sync:idle and emits wallet:txs"`, add `const file = openTempFileLog();` before `mod.start()`. After the first `await mod.stop()` (before `wallet2`):

```ts
    const text = file.read();
    file.close();
    expect(text).toContain("[parse-blocks] start");
    expect(text).toContain("[parse-blocks] allowed");
    expect(text).toContain("[parse-blocks] batch n=1 from=50 to=50");
    expect(text).toContain("[parse-blocks] stop");
```

In `"decode error emits module:status and keeps parsing subsequent blocks"`, add `const file = openTempFileLog();` before `mod.start()`. After `await mod.stop()`:

```ts
    expect(file.read()).toContain("[parse-blocks] decode height=10");
    file.close();
```

In `"sync:catchup pauses parsing; sync:idle resumes"`, add `const file = openTempFileLog();` before `mod.start()`. After `expect(db.parsedBlocks.has(2)).toBe(false)`:

```ts
    expect(file.read()).toContain("[parse-blocks] paused");
```

Call `file.close()` after the final `await mod.stop()`.

In `tests/unit/filters-matching.test.ts`, import the harness. In `"emits matching:progress on start and after each batch"`:

```ts
    const text = file.read();
    file.close();
    expect(text).toContain("[filters-matching] start");
    expect(text).toContain("[filters-matching] scan start scanned=1 total=3");
    expect(text).toContain("[filters-matching] scan done");
    expect(text).toContain("[filters-matching] stop");
```

In `"re-derives watchlist when key_value gaps grow"` after the rematch wait:

```ts
    expect(file.read()).toContain("[filters-matching] rematch from=");
    file.close();
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```
bun test tests/unit/parse-blocks.test.ts --test-name-pattern 'parses backlog after sync:idle|decode error emits|sync:catchup pauses'
bun test tests/unit/filters-matching.test.ts --test-name-pattern 'emits matching:progress on start|re-derives watchlist'
```

Expected: FAIL — missing scoped lines.

- [ ] **Step 3: Add the log calls**

`src/modules/parse-blocks.ts`:

```ts
import { log, logError } from "../log.ts";
```

`start` / `stop`: `log("parse-blocks", "start")` / `"stop"`.

On `sync:idle`: `allowed = true` then `log("parse-blocks", "allowed")`.

On `sync:catchup`: `allowed = false` then `log("parse-blocks", "paused")`.

In `parseBatch`, after the `blocks` array is filled and `blocks.length > 0`:

```ts
    log(
      "parse-blocks",
      `batch n=${blocks.length} from=${blocks[0]!.height} to=${blocks[blocks.length - 1]!.height}`,
    );
```

In the decode `catch`:

```ts
        logError("parse-blocks", `decode height=${block.height}`, err);
        failedHeights.add(block.height);
        // existing module:status emit
```

`src/modules/filters-matching.ts`:

```ts
import { log, logError } from "../log.ts";
```

`start` / `stop`: `log("filters-matching", "start")` / `"stop"`.

When gaps change and `markUnscannedFrom` runs:

```ts
          log(
            "filters-matching",
            `rematch from=${fromHeight} external=${gaps.external} internal=${gaps.internal}`,
          );
```

Around `scanFiltersForMatches`:

```ts
        let matches = 0;
        log(
          "filters-matching",
          `scan start scanned=${scannedCount} total=${ctx.db.filters.count()} external=${gaps.external} internal=${gaps.internal}`,
        );
        await scanFiltersForMatches(
          ctx.db,
          wallet.scripts(),
          {
            onMatch: (m) => {
              matches++;
              ctx.bus.emit("filters:match", m);
            },
            onProgress: (p) => {
              // existing progress emit — do not log each tick
```

After the scan returns (still in the try, before the peekGaps rematch check):

```ts
        log(
          "filters-matching",
          `scan done scanned=${scannedCount} total=${totalCount} matches=${matches}`,
        );
```

In the existing `catch`, add `logError("filters-matching", "scan", err)` before the status emit.

Do not log each filter height.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```
bun test tests/unit/parse-blocks.test.ts tests/unit/parse-blocks-gap.test.ts tests/unit/filters-matching.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/parse-blocks.ts src/modules/filters-matching.ts tests/unit/parse-blocks.test.ts tests/unit/filters-matching.test.ts
git commit -m "feat: log parse and match batch boundaries."
```

---

### Task 6: wallet gaps and birthday

**Files:**
- Modify: `src/wallet/wallet.ts`
- Modify: `src/wallet/birthday.ts`
- Test: `tests/unit/wallet.test.ts`
- Test: `tests/unit/wallet-birthday.test.ts`

**Interfaces:**
- Consumes: `log` from `src/log.ts`
- Produces:

```
[wallet] ready kind=<bip84|wif|address> external=<e> internal=<i>
[wallet] gaps grew external=<e> internal=<i>
[wallet] birthday pending
[wallet] birthday height=<h>
```

Never write `secret`, mnemonic words, WIF, or zpub into the log.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/wallet.test.ts` `"syncFromDb re-derives on gap growth; no-op when unchanged"`:

```ts
    const file = openTempFileLog();
    const db = createSqliteDatabase(":memory:");
    const wallet = createWallet(db, { secret: ABANDON, addressGap: 2 });
    expect(file.read()).toContain(
      "[wallet] ready kind=bip84 external=2 internal=2",
    );
    expect(file.read()).not.toContain(ABANDON);
    // ... existing syncFromDb false assertions ...
    saveWatchGaps(db, { external: 5, internal: 2 });
    expect(wallet.syncFromDb().grew).toBe(true);
    expect(file.read()).toContain("[wallet] gaps grew external=5 internal=2");
    expect(file.read()).not.toContain(ABANDON);
    file.close();
    db.close();
```

Import `openTempFileLog` at the top of that file.

In `tests/unit/wallet-birthday.test.ts` `"none → pending → freeze once..."`:

```ts
    const file = openTempFileLog();
    // ... existing assertions ...
    expect(file.read()).toContain("[wallet] birthday pending");
    expect(file.read()).toContain("[wallet] birthday height=950123");
    file.close();
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```
bun test tests/unit/wallet.test.ts --test-name-pattern 'syncFromDb re-derives'
bun test tests/unit/wallet-birthday.test.ts --test-name-pattern 'none'
```

Expected: FAIL — missing `[wallet]` lines.

- [ ] **Step 3: Add the log calls**

`src/wallet/wallet.ts`:

```ts
import { log } from "../log.ts";
```

After the first derive, before `return`:

```ts
  log(
    "wallet",
    `ready kind=${current.kind} external=${currentGaps.external} internal=${currentGaps.internal}`,
  );
```

In `syncFromDb`, inside `if (grew)` after re-derive:

```ts
      log(
        "wallet",
        `gaps grew external=${gaps.external} internal=${gaps.internal}`,
      );
```

`src/wallet/birthday.ts`:

```ts
import { log } from "../log.ts";
```

`markWalletBirthdayPending`:

```ts
  db.keyValue.set(WALLET_BIRTHDAY_HEIGHT_KEY, WALLET_BIRTHDAY_PENDING);
  log("wallet", "birthday pending");
```

`maybeFreezeWalletBirthday`, when the write happens:

```ts
  db.keyValue.set(WALLET_BIRTHDAY_HEIGHT_KEY, String(height));
  log("wallet", `birthday height=${height}`);
  return true;
```

Do not log in `loadWatchGaps` / `saveWatchGaps` (load persists defaults and would spam).

- [ ] **Step 4: Run tests to verify they pass**

Run:

```
bun test tests/unit/wallet.test.ts tests/unit/wallet-birthday.test.ts tests/unit/wif-wallet.test.ts tests/unit/address-watch-wallet.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wallet/wallet.ts src/wallet/birthday.ts tests/unit/wallet.test.ts tests/unit/wallet-birthday.test.ts
git commit -m "feat: log wallet kind, gap growth, and birthday."
```

---

### Task 7: TUI route and broadcast ids

**Files:**
- Modify: `src/tui/ui-route-store.ts`
- Modify: `src/tui/broadcast-actions.ts`
- Test: `tests/unit/ui-route-store.test.ts`
- Test: `tests/unit/tui-broadcast.test.ts`

**Interfaces:**
- Consumes: `log` from `src/log.ts`
- Produces: `[tui] route receive|send|txs`, `[tui] broadcast start id=<uuid>`, `[tui] broadcast cancel id=<id>`
- Must not contain the transaction hex.

- [ ] **Step 1: Write the failing tests**

`tests/unit/ui-route-store.test.ts`:

```ts
import { openTempFileLog } from "./file-log-harness.ts";

  test("logs route changes once per change", () => {
    const file = openTempFileLog();
    const store = createUiRouteStore();
    store.open("receive");
    store.open("receive");
    store.open("send");
    store.close();
    store.close();
    const text = file.read();
    file.close();
    expect(text).toContain("[tui] route receive");
    expect(text).toContain("[tui] route send");
    expect(text).toContain("[tui] route txs");
    expect(text.split("[tui] route receive").length - 1).toBe(1);
    expect(text.split("[tui] route txs").length - 1).toBe(1);
  });
```

In `tests/unit/tui-broadcast.test.ts`, add imports:

```ts
import { openTempFileLog } from "./file-log-harness.ts";
import {
  cancelBroadcast,
  setActiveBroadcastBus,
  startUiBroadcast,
} from "../../src/tui/broadcast-actions.ts";
```

(`setActiveBroadcastBus` and `startUiBroadcast` are already imported there. Add `cancelBroadcast` to that existing import. Do not duplicate the import block.)

In `"marks in-flight before the request so a sync done is not clobbered"`, wrap the `startUiBroadcast` call:

```ts
    const file = openTempFileLog();
    startUiBroadcast(store, "deadbeef");
    const text = file.read();
    file.close();
    expect(text).toMatch(/\[tui\] broadcast start id=[0-9a-f-]{36}/);
    expect(text).not.toContain("deadbeef");
```

Add this test in the same `describe`:

```ts
  test("logs broadcast cancel without hex", () => {
    const file = openTempFileLog();
    const bus = createMessageBus();
    setActiveBroadcastBus(bus);
    cancelBroadcast("job-1");
    const text = file.read();
    file.close();
    expect(text).toContain("[tui] broadcast cancel id=job-1");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```
bun test tests/unit/ui-route-store.test.ts tests/unit/tui-broadcast.test.ts
```

Expected: FAIL — missing `[tui]` lines.

- [ ] **Step 3: Add the log calls**

`src/tui/ui-route-store.ts`:

```ts
import { log } from "../log.ts";
```

In `set`, after the no-op check:

```ts
    route = next;
    log("tui", `route ${next}`);
    for (const listener of [...listeners]) listener();
```

`src/tui/broadcast-actions.ts`:

```ts
import { log } from "../log.ts";
```

In `startUiBroadcast`, after `store.begin(id, txHex)`:

```ts
  log("tui", `broadcast start id=${id}`);
  requestBroadcast(txHex, id);
```

In `cancelBroadcast`:

```ts
  log("tui", `broadcast cancel id=${id}`);
  bus.emit("broadcast:cancel", { id });
```

Do not pass `txHex` into `log`.

Quit is already `[main] shutdown` from Task 1. Do not log every keypress.

- [ ] **Step 4: Run tests to verify they pass**

Run:

```
bun test tests/unit/ui-route-store.test.ts tests/unit/tui-broadcast.test.ts tests/unit/broadcast-module.test.ts
bun test tests/unit
bun run typecheck
```

Expected: PASS. Existing download / broadcast log assertions stay green.

- [ ] **Step 5: Commit**

```bash
git add src/tui/ui-route-store.ts src/tui/broadcast-actions.ts tests/unit/ui-route-store.test.ts tests/unit/tui-broadcast.test.ts
git commit -m "feat: log TUI route and broadcast ids."
```

---

## Spec coverage

| Spec item | Task |
|-----------|------|
| Exact `--log` token; path unchanged | 1 |
| Silent when unset | 1 |
| `shouldEnableFileLog` | 1 |
| Boot / onboarding / startApp / shutdown / module start fail | 1 |
| `sync-idle` reason | 2 |
| Peer DNS / probe fail / pause | 3 |
| Header apply / rewind / peer fail | 4 |
| Parse + match batch boundaries | 5 |
| Wallet gaps + birthday; no secrets | 6 |
| TUI route + send/receive; quit via main shutdown | 7 |
| Broadcast already logs; TUI adds id-only start | 7 |
| Download modules unchanged | — |
| No Logger / levels / `--log <path>` | all |
| `net` failures modules do not already log | 3 + 4 (probe + header peer fail) |
