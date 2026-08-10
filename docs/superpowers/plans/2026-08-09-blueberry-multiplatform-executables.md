# Multi-platform blueberry executables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `bun build --compile` script and a GitHub Actions workflow that builds `blueberry` on Linux, Windows, and macOS runners, uploads artifacts, and attaches binaries to GitHub Releases on `v*` tags.

**Architecture:** One `build.yml` workflow with a four-entry runner matrix. Each job installs deps on that OS so `@opentui` native packages match the host, then compiles a standalone binary. A tag-only release job downloads all artifacts and publishes them with `softprops/action-gh-release`.

**Tech Stack:** Bun (`bun build --compile`), GitHub Actions (`ubuntu-latest`, `windows-latest`, `macos-15`, `macos-15-intel`), `oven-sh/setup-bun@v2`, `actions/upload-artifact@v4`, `actions/download-artifact@v4`, `softprops/action-gh-release@v2`.

**Spec:** `docs/superpowers/specs/2026-08-09-blueberry-multiplatform-executables-design.md`

## Global Constraints

- Executable base name: `blueberry` / `blueberry.exe`
- Artifact OS label: `macos` (not `darwin`)
- Targets: `linux-x64`, `windows-x64`, `macos-arm64`, `macos-x64`
- Bun in CI: `latest` (same as `test.yml`)
- Triggers: pull requests, push to `master`, tags `v*`
- No Apple code signing
- Do not change `.github/workflows/test.yml`
- `dist/` is already gitignored

## File map

| Path | Responsibility |
|------|----------------|
| `package.json` | `build` script → compile `src/main.tsx` to `dist/blueberry` |
| `.github/workflows/build.yml` | Matrix build jobs + tag release job |

---

### Task 1: Add local `build` script

**Files:**
- Modify: `package.json`
- Test: local `bun run build` (produces `dist/blueberry`)

**Interfaces:**
- Consumes: `src/main.tsx` entrypoint (existing)
- Produces: npm script `build` that writes `dist/blueberry` (Windows CI may see `dist/blueberry.exe`)

- [ ] **Step 1: Add the script**

In `package.json`, add `"build"` next to the other scripts:

```json
"scripts": {
  "start": "bun src/main.tsx",
  "build": "bun build --compile --outfile=dist/blueberry src/main.tsx",
  "typecheck": "tsc --noEmit",
  "test:unit": "bun test tests/unit",
  "test:integration": "bun test tests/integration"
}
```

- [ ] **Step 2: Run the build locally**

Run: `bun run build`

Expected: exit 0; console shows `compile  dist/blueberry` (or similar); file `dist/blueberry` exists and is executable.

Run: `test -x dist/blueberry && ls -lh dist/blueberry`

Expected: executable binary present (size on the order of ~100MB).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
Add bun compile script for blueberry executable.

EOF
)"
```

---

### Task 2: Add matrix build + release workflow

**Files:**
- Create: `.github/workflows/build.yml`
- Test: workflow YAML is valid; local build still works (CI validates on push/PR)

**Interfaces:**
- Consumes: `bun run build` from Task 1
- Produces: Actions artifacts `blueberry-linux-x64`, `blueberry-windows-x64`, `blueberry-macos-arm64`, `blueberry-macos-x64`; on `v*` tags, a GitHub Release with the four binary files named as in the spec

- [ ] **Step 1: Create `.github/workflows/build.yml`**

Create the file with exactly this content:

```yaml
name: Build

on:
  pull_request:
  push:
    branches:
      - master
    tags:
      - "v*"

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - runner: ubuntu-latest
            artifact: blueberry-linux-x64
            binary: blueberry-linux-x64
          - runner: windows-latest
            artifact: blueberry-windows-x64
            binary: blueberry-windows-x64.exe
          - runner: macos-15
            artifact: blueberry-macos-arm64
            binary: blueberry-macos-arm64
          - runner: macos-15-intel
            artifact: blueberry-macos-x64
            binary: blueberry-macos-x64
    runs-on: ${{ matrix.runner }}
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Build
        run: bun run build

      - name: Name binary
        shell: bash
        run: |
          if [ -f dist/blueberry.exe ]; then
            mv dist/blueberry.exe "dist/${{ matrix.binary }}"
          elif [ -f dist/blueberry ]; then
            mv dist/blueberry "dist/${{ matrix.binary }}"
          else
            echo "Compiled binary not found under dist/" >&2
            ls -la dist/ || true
            exit 1
          fi

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: dist/${{ matrix.binary }}
          if-no-files-found: error

  release:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Download artifacts
        uses: actions/download-artifact@v4
        with:
          pattern: blueberry-*
          path: artifacts
          merge-multiple: true

      - name: Publish GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            artifacts/blueberry-linux-x64
            artifacts/blueberry-windows-x64.exe
            artifacts/blueberry-macos-arm64
            artifacts/blueberry-macos-x64
```

- [ ] **Step 2: Sanity-check YAML and local build still works**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('ok')"`

Expected: `ok` (if PyYAML is missing, run `bun run build` only and visually confirm the file matches Step 1).

Run: `bun run build`

Expected: exit 0; `dist/blueberry` exists.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
Add CI builds for linux, windows, and macos blueberry binaries.

EOF
)"
```

- [ ] **Step 4: After push, verify CI (manual)**

On the next push or PR:

1. Open the Actions run for **Build**.
2. Confirm four matrix jobs finish green.
3. Confirm each job uploaded its artifact.
4. (Optional later) Push a `v*` tag and confirm the Release job attaches all four files.

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| `package.json` `build` script | Task 1 |
| Matrix runners + artifact names with `macos` | Task 2 |
| `bun install` on each platform | Task 2 |
| PR + `master` + `v*` triggers | Task 2 |
| Actions artifacts on PR/`master` | Task 2 |
| GitHub Release on `v*` | Task 2 |
| No signing; `test.yml` untouched | Task 2 (omission) |
