---
type: SETTLEMENT_PENDING
summary: A finished market's result was never recorded, so its position can't settle.
first_steps:
  - Check the event on the venue for its result.
  - Check the classifier's settlement loop.
  - Record the settlement once known.
---

## What it means

The listing was deactivated over a day ago, a position is still open, and no settlement value is recorded.

## Impact

The position is valued at a stale mark and its capital stays committed.

## Diagnose

Did the classifier see the market resolve? Its logs and the event's page in the controller.

## Resolve

Once the result is recorded, the settlement sweeper books it within 5 minutes.

## Escalate

No, unless the capital is needed.

## Related

[SETTLEMENT_BLOCKED](SETTLEMENT_BLOCKED.md)
