---
type: FEE_TYPE_UNSUPPORTED
summary: Kalshi charges a series or event a fee type no fee schedule can express, so its fees fall through to the default.
first_steps:
  - Look up the series or event's fee type on Kalshi.
  - Record its real schedule in Security Master → Fees.
---

## What it means

Kalshi's API gave a series or event a fee type the classifier has no formula for (anything other than the quadratic
types, e.g. a flat fee table). The classifier recorded a schedule with no definition, so the series falls through to
the exchange default and an event to its series.

## Impact

Backtests and fee recon on that series or event use the wrong fees until the real schedule is recorded.

## Diagnose

Kalshi's fee schedule (kalshi.com/docs/kalshi-fee-schedule.pdf) and `GET /series/{ticker}` give the fee type. The
classifier's supported types are `KALSHI_MAKER_SHARE` in gnome-classifier `classifier/stages/fees.py`.

## Resolve

Record the schedule in Security Master → Fees at the same effective date (a `PER_UNIT` component expresses a flat
fee per contract). The finding clears once the latest schedule for the target is no longer the unsupported one. If
the type will recur, teach the classifier to express it.

## Escalate

No.

## Related

[FEE_SCHEDULE_CHANGED](FEE_SCHEDULE_CHANGED.md)
