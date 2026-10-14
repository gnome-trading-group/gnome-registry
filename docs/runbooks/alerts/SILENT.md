---
type: SILENT
summary: A running session stopped sending heartbeats; its process may be dead or hung.
first_steps:
  - Open the session page; check its instance on /system → Trading fleet.
  - If live: check the venue for resting orders.
  - Pull the logs before the instance terminates.
---

## What it means

The session is RUNNING but its last heartbeat (sent every 5 seconds) is over 60 seconds old, or it never sent one 2 minutes after starting.

## Impact

Nothing is managing its orders or positions. If the process died, the instance shuts down and the session turns FAILED within a minute or two; if it hung, its gateways may still be connected.

## Diagnose

Check the instance state, then the logs ([inspect-session](../procedures/inspect-session.md)). A hung JVM is still running but its agents report nothing; take a thread dump before stopping it. Several sessions silent at once points at the registry instead (SESSIONS_SILENT_MULTIPLE).

## Resolve

If live, make sure the venue is flat ([check-venue-orders](../procedures/check-venue-orders.md)). Stop the session; relaunch once the cause is understood.

## Escalate

Escalate if the venue can't be checked or the session can't be stopped.

## Related

[inspect-session](../procedures/inspect-session.md), [check-venue-orders](../procedures/check-venue-orders.md), [registry-down](../procedures/registry-down.md)
