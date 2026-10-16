---
type: FEE_SCHEDULE_MISSING
summary: A live fill landed where the registry knows no fee schedule for its listing.
first_steps:
  - Open the listing in Security Master and check its Fees timeline.
  - Record the venue's schedule for that time.
---

## What it means

A live Kalshi or Polymarket US fill happened at a time none of the listing's fee schedules (listing, fee event, fee
group or exchange) cover, so its fee couldn't be checked.

## Impact

Fees on this listing aren't checked against the venue, and backtests over that time stop with no known fees.

## Diagnose

Security Master → the listing → Fees shows the gap. Polymarket US's schedule is only known from 2026-04-03.

## Resolve

Record the venue's schedule in Security Master → Fees, effective from the start of the gap.

## Escalate

No.

## Related

[FEE_MISMATCH](FEE_MISMATCH.md)
