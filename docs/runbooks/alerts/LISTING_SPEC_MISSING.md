---
type: LISTING_SPEC_MISSING
summary: Active listings on an exchange have no listing spec, so the OMS refuses every order on them.
first_steps:
  - Check the spec sync's latest runs in its Lambda log (`SpecSyncStack`, the `spec-sync-lambda` function).
  - Look at one of the example listings at its venue: does the venue still list the market?
---

## What it means

The spec sync gives every active listing a spec within a minute of its creation, read from its venue (tick grid, lot,
minimums). These listings have been active for over five minutes with none. The alert counts them per exchange and
names a few.

## Impact

The OMS refuses every order on a listing with no spec, so no session can trade these listings. Backtests over them
can't run either.

## Diagnose

- The spec sync's log shows each pass per venue: `targets`, `unknown` (the venue didn't answer for a listing),
  `invalid` (it answered with a grid the registry refuses) and `failed` (the registry refused the write). A venue
  that fails outright also raises the `Registry-SpecSync` Lambda alarm.
- `unknown` listings: the venue no longer lists the market under that id (delisted, renamed), or its reader can't
  find it (a closed Polymarket Intl market Gamma omits; a Kalshi market only under `/historical/markets`).
- `invalid`: the venue's tick structure isn't contiguous from 0 or has an edge off its step; the warning in the log
  shows the bands.

## Resolve

- A venue outage clears itself on the next pass once the venue answers.
- A listing the venue dropped: mark it inactive (`PATCH /listings`), which ends the alert for it.
- A reader that can't express the venue's structure: fix the reader in `cdk/lambda/sync/venues/<venue>.ts` and
  release; the next pass writes the specs.

## Escalate

No, unless a strategy needs one of these listings now: then fix the reader first.

## Related

[Registry CloudWatch alarms](../cloudwatch/Registry.md)
