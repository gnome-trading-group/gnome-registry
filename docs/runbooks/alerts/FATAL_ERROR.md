---
type: FATAL_ERROR
summary: A session hit an unrecoverable error and is exiting.
first_steps:
  - Read the error in the alert.
  - If live: check the venue for resting orders.
  - Fix the cause before relaunching.
---

## What it means

The orchestrator caught an error it can't continue from (an agent failing, a gateway that can't connect, a startup that can't finish) and is exiting. It reported this before exiting; the session turns FAILED shortly after.

## Impact

The OMS's clean shutdown tries to cancel everything, but only if its order gateway still works. A startup failure exits before trading.

## Diagnose

The error and top of the stack are in the alert; the full trace is in the logs ([inspect-session](../procedures/inspect-session.md)). Startup errors name what's missing: a venue account, credentials, an unreachable venue.

## Resolve

If live, make sure the venue is flat ([check-venue-orders](../procedures/check-venue-orders.md)). Fix the cause (credentials, accounts, the venue), then relaunch.

## Escalate

Escalate if the venue can't be checked.

## Related

[FAILED](FAILED.md), [accounts](../procedures/accounts.md), [check-venue-orders](../procedures/check-venue-orders.md)
