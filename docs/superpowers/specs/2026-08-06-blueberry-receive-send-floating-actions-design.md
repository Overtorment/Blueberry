# blueberry Receive / Send floating actions design

Date: 2026-08-06  
Status: approved (conversation)

## Goal

Add **Receive** and **Send** actions that float above the Transactions stage, opening empty placeholder modals for later wallet flows. Transactions remains a list-only panel; overlay chrome lives at the App stage.

## Decisions

| Topic | Choice |
|-------|--------|
| Scope this pass | Placeholders only (no address derivation / send logic) |
| Modal presentation | Centered overlay over the Transactions **stage** (strip + Balance stay visible) |
| Action placement | Bottom-center floating pair |
| Host of buttons/modal | App-stage siblings — **not** inside `Transactions` / `Panel` |
| Navigation | Global UI route store (`"txs" \| "receive" \| "send"`) |
| Dismiss | Visible **Close** + **Esc** → `"txs"` |
| Quit | Global `q` still quits the app (unchanged, including while modal open) |

## Layout / layering

```
App
  sync strip
  Balance | Blueberry
  stage (relative, flexGrow)          ← same UI level as strip / balance
    Transactions                      ← fills stage; list + parse status only
    ActionBar (absolute, bottom-center, zIndex↑)   when route === "txs"
    Modal   (absolute, centered, zIndex↑↑)         when receive | send
```

- Floating bar covers the lower middle of the stage (may obscure last tx rows). Do **not** change `reservedLines` / `txListCapacity` for the bar.
- Modal is scoped to the stage box, not a full-app takeover.
- `Transactions` does not import or render action buttons or the modal.

## Route store

New in-memory store following existing TUI store patterns (`subscribe` + stable snapshot for `useSyncExternalStore`):

| API | Behavior |
|-----|----------|
| `get()` / snapshot | Current route: `"txs" \| "receive" \| "send"` |
| `open("receive" \| "send")` | Set route; no-op if already that route |
| `close()` | Set route to `"txs"` |

Bootstrap like other stores: create in `main.tsx`, `setActiveUiRouteStore`, React hook `useUiRoute()`.

## UI behavior

**Action bar** (route `"txs"` only)

- Two controls: **Receive**, **Send** (bottom-center, side by side).
- Activate → `open("receive")` or `open("send")`.
- Mouse click and/or keyboard focus+activate as OpenTUI allows; keep implementation minimal (bordered boxes with `onMouseDown` / registered button if already used elsewhere).

**Modal** (route `"receive"` \| `"send"`)

- Title: Receive or Send.
- Body: short placeholder copy (e.g. “Coming soon”).
- Visible **Close** control → `close()`.
- **Esc** → `close()`. Wire Esc in the App stage (or a small hook that reads the route store) without changing Ctrl+C / `q` quit behavior.
- While modal is open, hide the action bar.

## Styling

- Reuse `THEME` / Panel accents (256-color only): **Receive** = magenta, **Send** = cyan (matches Balance / Transactions pairing).
- Modal and bar use the same border/title conventions as other chrome where practical.

## Files (approx.)

| Path | Role |
|------|------|
| `src/tui/ui-route-store.ts` | Route store |
| `src/tui/use-ui-route.ts` | Active store + hook |
| `src/tui/components/ActionBar.tsx` | Floating Receive / Send |
| `src/tui/components/WalletModal.tsx` | Placeholder modal + Close |
| `src/tui/App.tsx` | Stage wrapper; mount overlays; Esc → `close()` |
| `src/main.tsx` | Create + activate route store |
| `tests/ui-route-store.test.ts` | open / close / idempotent open |

`Transactions.tsx` stays presentation of txs + parse progress/ETA only.

## Out of scope

- Showing a receive address, QR, or amount
- Building / broadcasting a send
- Full-app modal covering Balance / sync strip
- Changing quit keys or parse ETA / capacity logic

## Testing

- Unit: store starts at `"txs"`; `open` / `close`; `open` same route is stable/idempotent.
- Manual: bar floats above txs; opening modal hides bar and shows placeholder; Close and Esc return to txs; `q` still quits.
