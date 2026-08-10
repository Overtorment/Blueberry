# blueberry TUI cyberpunk redesign

Date: 2026-08-03  
Status: approved (conversation)

## Goal

Restyle and restack the OpenTUI dashboard into a neon cyberpunk, wallet-first console with full-theater motion, using only the xterm 256-color palette so colors stay intact inside GNU `screen`.

## Decisions

| Topic | Choice |
|-------|--------|
| Aesthetic | Neon cyberpunk |
| Layout approach | Strip + stage (Approach 1) |
| Stage arrangement | Stacked: Balance banner over Transactions |
| Motion | Full suite — title pulse, bar-tip blink, sync-bar scan; done = solid green, quiet |
| Color depth | 256-color only (`RGBA.fromIndex` / cube indices; no truecolor hex) |
| Accent pairing | Cyan chrome + magenta wallet accent |
| Domain logic | Unchanged — presentation-only redesign |

## Layout

```
┌ Peers │ Chain tip │ Filters DL │ Matching │ Blocks ┐  ← short sync strip
├────────────────── Balance banner ──────────────────┤
│                   Transactions                      │  ← flexGrow
└────────────────────────────────────────────────────┘
```

- Sync strip: five compact tiles with mini progress bars (Peers shows count only).
- Balance: full-width banner under the strip (hero wallet signal).
- Transactions: fills remaining height.
- Narrow terminals: strip tiles shrink to title + bar/%; no horizontal scroll.
- Quit remains Ctrl+C. Optional one-line footer hint only if space allows; otherwise omit.

## Theme (256-color)

Central `src/tui/theme.ts` exposes role tokens backed by ansi256 indices:

| Token | Role |
|-------|------|
| `bg` | Near-black panel background |
| `fg` / `fgDim` | Body / idle text |
| `accentCyan` | Sync chrome, Transactions border/title, progress fills |
| `accentMagenta` | Balance border/title, alternating strip accents |
| `done` | Bright green for 100% complete panels |
| `borderIdle` / `borderActive` | Dim vs bright border by panel state |

Rules:

- Idle text/borders dim; active panels bright; complete panels use `done` and stop motion.
- Alternating cyan/magenta on sync strip titles for neon rhythm.
- Never pass free truecolor hex that `screen` cannot map cleanly.

## Theater

`src/tui/use-theater.ts` (or equivalent) ticks ~250–400ms and drives:

1. **Title pulse** — opacity/bright toggle on active panel titles (`◆` glyph prefix).
2. **Bar tip blink** — trailing tip glyph on in-progress bars.
3. **Scan frame** — cycling highlight cell(s) across the filled portion of active sync bars.

Idle and done panels receive no ticks. Animation is React-timer text/attribute updates only — no OSC tricks, no truecolor fades.

## Components / files

| Path | Change |
|------|--------|
| `src/tui/theme.ts` | New — palette + role tokens |
| `src/tui/chrome.tsx` | New — shared bordered panel (border style, title glyph, state colors) |
| `src/tui/progress-format.ts` | Richer block/braille bars + tip/scan frames; keep `formatEta` |
| `src/tui/use-theater.ts` | New — tick hook for motion frames |
| `src/tui/App.tsx` | Restack to strip → Balance → Transactions |
| `src/tui/components/*.tsx` | Restyle via chrome/theme; same hooks/data |
| Stores, bus, modules, `main.tsx` start order | No functional change |

Panel state derivation (presentation only):

- Progress tiles: `percent <= 0` → idle; `0 < percent < 100` → active; `percent >= 100` → done.
- Peers: `count > 0` → active; else idle (never “done”).
- Balance / Transactions: status string is `"…"` or empty → idle; any other status → active (never “done” until real wallet completion exists later).

## Data flow

Unchanged:

```
domain modules → bus events → tui stores → hooks → tile components
```

Theater ticks and theme tokens affect rendering only.

## Testing

- Unit tests for `progress-format`: width, 0%/100%, tip frame characters.
- Unit tests that theme tokens resolve to ansi256 indices (not free hex strings).
- Leave existing TUI store-wiring tests as-is.
- No OpenTUI render snapshot tests.

## Out of scope

- New wallet/sync features or richer Transactions list content beyond current status text
- Mouse focus, clickable tiles, truecolor, sound
- Changing quit semantics or module start order in `main.tsx`
- Reworking bus event shapes or progress ETA algorithms

## Success criteria

1. `bun start` shows stacked wallet-first cyberpunk layout with cyan/magenta accents.
2. Active sync panels animate; completed panels go solid green and stop motion.
3. Inside GNU `screen`, colors remain stable (256 palette; no broken/garbled truecolor).
4. Existing progress/store tests still pass; new format/theme unit tests pass.
