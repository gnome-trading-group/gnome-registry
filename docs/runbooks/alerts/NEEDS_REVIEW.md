---
type: NEEDS_REVIEW
summary: A position lost ledger events; recovery refuses to trade it until it's adjusted.
first_steps:
  - Compare the position with the venue.
  - Adjust it on the controller (ledger adjustments).
  - Confirm the alert resolves.
---

## What it means

Ledger events for this position were lost (a gap), so the ledger can't vouch for its quantity. A starting session halts the listing rather than trade it.

## Impact

The strategy can't trade this listing until someone corrects the position.

## Diagnose

The venue's position and fills vs the ledger's (Fills & Orders, Treasury reconciliation).

## Resolve

Record an adjustment that brings the ledger to what the venue holds; that clears the review.

## Escalate

Escalate if you can't tell what the venue holds.

## Related

[check-venue-orders](../procedures/check-venue-orders.md)
