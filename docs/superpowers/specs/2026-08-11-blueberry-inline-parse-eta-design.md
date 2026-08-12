# Inline Block-Parse ETA

## Goal

Keep block-parse progress and its optional ETA visible in short terminals by
rendering both on one status row.

## UI

- While a parse backlog exists and ETA is unavailable, show:
  `332/500 blocks parsed`
- While a parse backlog exists and ETA is available, show:
  `332/500 blocks parsed (ETA 4m)`
- Continue hiding the entire parse-progress row when no backlog exists.
- Reserve exactly one Transactions-panel row for parse progress, regardless of
  whether ETA is available.

## Scope

Only the Transactions-panel presentation and its layout tests change. ETA
sampling, pause/resume behavior, sync event wiring, parsing, and downloads stay
unchanged.

## Tests

- Verify the combined text with and without ETA.
- Verify Transactions capacity reserves one status row when ETA is present.
