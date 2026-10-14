---
type: NO_PRICE
summary: A held position has had no price for over an hour.
first_steps:
  - Check whether the market is simply quiet.
  - Check the collector for that venue.
  - Nothing to do if the market is quiet.
---

## What it means

No mark for this listing in the last hour while a position is open. Prediction markets can be quiet for hours.

## Impact

PnL values the position at its last known price.

## Diagnose

Is the market active on the venue? Are collectors healthy (Market Data → Collectors)?

## Resolve

None needed for a quiet market. A collector problem is fixed there.

## Escalate

No.

## Related

[SETTLEMENT_PENDING](SETTLEMENT_PENDING.md)
