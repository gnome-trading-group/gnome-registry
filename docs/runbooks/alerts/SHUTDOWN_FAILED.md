---
type: SHUTDOWN_FAILED
summary: The launcher couldn't stop a session it meant to stop.
first_steps:
  - Stop the session from the controller.
  - If that fails, terminate its instance in EC2.
  - If live: check the venue.
---

## What it means

A launcher rule decided to stop a session, and the stop call failed.

## Impact

The session keeps trading past when it should have stopped.

## Diagnose

The alert has the error; the launcher's ShutdownProcessor logs have more.

## Resolve

Stop it by hand.

## Escalate

Escalate if it can't be stopped.

## Related

[stop-or-kill](../procedures/stop-or-kill.md)
