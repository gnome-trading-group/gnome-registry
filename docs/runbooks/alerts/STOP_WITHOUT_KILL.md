---
type: STOP_WITHOUT_KILL
summary: A session was stopped but its kill switch couldn't be set.
first_steps:
  - Check the venue for orders the session left.
  - Cancel anything left resting.
  - Check the registry's /risk/halts endpoint.
---

## What it means

A stop sets the session's kill switch so the OMS cancels before the instance goes. That failed, and the instance was terminated anyway.

## Impact

The OMS's shutdown still tries to cancel, but if it couldn't, orders are resting with no session behind them.

## Diagnose

The alert carries the halt's error; the registry launcher Lambda's logs have more.

## Resolve

Make sure the venue is flat ([check-venue-orders](../procedures/check-venue-orders.md)).

## Escalate

Escalate if the venue can't be checked.

## Related

[check-venue-orders](../procedures/check-venue-orders.md), [stop-or-kill](../procedures/stop-or-kill.md)
