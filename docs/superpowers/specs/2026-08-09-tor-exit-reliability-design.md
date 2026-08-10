# Tor exit dial reliability design

Date: 2026-08-09  
Status: approved for implementation (approvals skipped by request)

## Goal

Make rare Tor exit dials reliable for broadcast and the live integration test.
Retries and short circuit races are OK. No warm dialer. Stay pure in-process
meek / echalote (no system Tor SOCKS).

## Split

| Layer | Owns |
|--------|------|
| **echalote** | Reliable exit circuit: retry transient directory/extend failures; race a few circuit builds; recycle meek when bootstrap is dead |
| **Blueberry** | Dial policy: recycle dialer across attempts; backoff; peer loop for broadcast + integration test |

## echalote

1. Retry on microdesc fail, consensus fail, extend timeout, destroyed circuit.
   Stop on abort or non-transient errors.
2. Parallel authority / microdesc GETs (small concurrency cap) with per-URL timeouts.
3. Race `circuitRace` builds (default 2); first success wins; close losers.
4. After attempt budget fails, tear down Tor client + meek once and bootstrap again
   before final failure.
5. Keep `createExitDialer(options)`; add `circuitRace` (and keep existing timeout /
   attempt knobs). Defaults improve reliability without Blueberry changes.

## Blueberry

1. Shared dial-policy helper: default 3 outer cycles (create dialer → dial → dispose).
2. Short backoff between cycles; abort cancels retries.
3. Wire broadcast module and `tor-v1-seed` integration test through the helper.

## Non-goals

System Tor, Snowflake, warm long-lived circuits, onion peers, directory-only-over-Tor.

## Success bar

- Rare broadcast usually succeeds within a few minutes with retries.
- Local + CI integration usually passes without manual re-run.
