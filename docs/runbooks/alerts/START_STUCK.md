---
type: START_STUCK
summary: A session has been launching for 15 minutes without starting.
first_steps:
  - Open the session page and its instance on /system.
  - Read the logs for where startup stopped.
  - Stop it and relaunch.
---

## What it means

The session is still SUBMITTED or STARTING with no heartbeat, 15 minutes after launch. Launch covers EC2 boot, the AMI's setup and the JVM's startup and recovery.

## Impact

It isn't trading. A startup that throws now exits with a FATAL_ERROR; one that hangs (a venue it can't reach, a recovery that can't finish) may sit with gateways connected.

## Diagnose

The instance state, then the logs ([inspect-session](../procedures/inspect-session.md)). No instance at all means the launch itself failed.

## Resolve

Stop the session. Relaunch once the cause is fixed.

## Escalate

Escalate if it's live and the venue shows orders from it.

## Related

[inspect-session](../procedures/inspect-session.md)
