# blueberry multi-platform executables (CI)

Date: 2026-08-09  
Status: approved

## Goal

Build standalone `blueberry` executables for Linux, Windows, and macOS in CI. Each target runs on a matching GitHub Actions runner so `bun install` pulls the correct native `@opentui` packages. On version tags, attach the binaries to a GitHub Release.

## Decisions

| Topic | Choice |
|-------|--------|
| Approach | One workflow with a runner matrix (not cross-compile from Linux) |
| Triggers | Pull requests; push to `master`; tags `v*` |
| Bun version | `latest` (same as `test.yml`) |
| Executable base name | `blueberry` / `blueberry.exe` |
| macOS arches | arm64 (`macos-15`) and x64 (`macos-15-intel`) |
| Artifact OS label | `macos` (not `darwin`) |
| PR / `master` output | Actions artifacts only |
| Tag output | GitHub Release assets for all four binaries |
| Signing | None (layerzwallet signs Electrobun macOS GUI only; not needed here) |
| `dist/` | Already in `.gitignore`; no change |

## Why native runners

`@opentui/core` depends on optional platform packages (`@opentui/core-linux-x64`, `@opentui/core-darwin-arm64`, etc.). Those install only when `bun install` runs on the matching OS/arch. Cross-compile on one runner would miss the wrong native bits.

Pattern matches `layerztec/layerzwallet` desktop builds: one runner per host platform, then `bun install`, then build.

## Matrix

| Runner | Output file | Artifact name |
|--------|-------------|---------------|
| `ubuntu-latest` | `blueberry-linux-x64` | `blueberry-linux-x64` |
| `windows-latest` | `blueberry-windows-x64.exe` | `blueberry-windows-x64` |
| `macos-15` | `blueberry-macos-arm64` | `blueberry-macos-arm64` |
| `macos-15-intel` | `blueberry-macos-x64` | `blueberry-macos-x64` |

`fail-fast: false` so one OS failure does not cancel the others.

## Build steps (each matrix job)

1. Checkout
2. Setup Bun (`oven-sh/setup-bun@v2`, `bun-version: latest`)
3. `bun install --frozen-lockfile`
4. `bun run build` (see script below)
5. Place the binary under the platform-specific name above
6. Upload Actions artifact (`if-no-files-found: error`)

No Node setup. No Apple certs.

## `package.json` script

Add:

```json
"build": "bun build --compile --outfile=dist/blueberry src/main.tsx"
```

CI renames/copies `dist/blueberry` (or `dist/blueberry.exe` on Windows) to the platform-specific name before upload. Local builds keep the short `dist/blueberry` name.

## Releases (tags `v*` only)

A job that `needs` the matrix build:

1. Download all four artifacts
2. Create or update a GitHub Release for the tag
3. Attach:
   - `blueberry-linux-x64`
   - `blueberry-windows-x64.exe`
   - `blueberry-macos-arm64`
   - `blueberry-macos-x64`

PR and `master` runs skip this job.

## Files

| Path | Change |
|------|--------|
| `.github/workflows/build.yml` | New: matrix build + release job |
| `package.json` | Add `build` script |
| `.github/workflows/test.yml` | Unchanged |

## Out of scope

- Apple code signing / notarization
- Linux arm64
- Homebrew or other package managers
- Syncing `package.json` version from the git tag
