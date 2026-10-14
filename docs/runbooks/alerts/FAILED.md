---
type: FAILED
summary: A session died without a stop request.
first_steps:
  - Read the failure reason on the alert or session page.
  - If live: check the venue for resting orders.
  - Fix the cause before relaunching.
---

## What it means

The session's instance shut down or terminated without anyone stopping it. The failure reason is the orchestrator's own error when it reported one, otherwise the instance state.

## Impact

Nothing manages its orders or positions. Its kill switch (if any) and listings are released once the instance is gone.

## Diagnose

The failure reason, then the logs ([inspect-session](../procedures/inspect-session.md)). A FATAL_ERROR alert before it carries the exception.

## Resolve

If live, make sure the venue is flat ([check-venue-orders](../procedures/check-venue-orders.md)). Relaunch once the cause is fixed; recovery inherits the ledger's positions.

## Escalate

Escalate if the venue can't be checked.

## Related

[FATAL_ERROR](FATAL_ERROR.md), [check-venue-orders](../procedures/check-venue-orders.md)
