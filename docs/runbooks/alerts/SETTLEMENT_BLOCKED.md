---
type: SETTLEMENT_BLOCKED
summary: A settled market still has an open position.
first_steps:
  - Read the detail: needs review, held by a session, or not booked.
  - Act on that cause.
  - Confirm the sweeper books it.
---

## What it means

The market has a settlement value but the position is still open: it needs review, a session still holds the listing, or the sweeper hasn't booked it for 15 minutes.

## Impact

The position is valued at a stale mark and its capital stays committed.

## Diagnose

The detail line says which. The sweeper's errors are in its Lambda logs (Registry-SettlementSweeper alarm).

## Resolve

Adjust a position under review, stop the session holding it, or fix the sweeper.

## Escalate

No.

## Related

[NEEDS_REVIEW](NEEDS_REVIEW.md), [Registry](../cloudwatch/Registry.md)
