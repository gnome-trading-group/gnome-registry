---
type: FEE_SCHEDULE_CHANGED
summary: A venue's API changed the fees of some fee groups (Kalshi series, Polymarket International fee types).
first_steps:
  - Read the finding's detail for the groups, dates and rates.
  - Check any "dated from when first seen" entry against the venue's announcements.
---

## What it means

The classifier's fee sync recorded new schedules for fee groups in the last day: a Kalshi series fee change, or a
Polymarket International fee type it hadn't seen or seen at other rates. The fees are already in effect for
backtests and recon; this is for someone to look over. Kalshi event overrides aren't reported.

## Impact

None on its own. A Polymarket International fee type the classifier has no rollout date for is dated from when it
first saw it, so backtests before then charge whatever applied before (usually nothing).

## Diagnose

Security Master → Fees lists each group's schedules. Polymarket International's rollout dates live in
`POLYMARKET_INTL_FEE_TYPES` (gnome-classifier `classifier/stages/fees.py`).

## Resolve

If a date is wrong, record a corrected schedule in Security Master → Fees at the right effective date, and add the
type to `POLYMARKET_INTL_FEE_TYPES` so a fresh environment dates it right too. The finding clears a day after the
schedules were recorded.

## Escalate

No.

## Related

[FEE_TYPE_UNSUPPORTED](FEE_TYPE_UNSUPPORTED.md), [FEE_MISMATCH](FEE_MISMATCH.md)
