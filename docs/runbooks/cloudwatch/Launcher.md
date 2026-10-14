---
type: Launcher
summary: A launcher alarm fired: a trigger, launch or shutdown may not have happened.
first_steps:
  - Open the alarm to see which queue or function.
  - If it's the Shutdown DLQ: find the session and stop it by hand.
  - Read the function's logs, then redrive the DLQ.
---

## What it means

Alarms named `Launcher-…`:

| Alarm | Fires when |
|---|---|
| Launcher / ClassifierAdapter / Shutdown DLQ | a trigger failed three times and was set aside |
| queue age | triggers waiting too long |
| TriggerProcessor / ShutdownProcessor / ScheduledLaunch / SlackInteraction errors | a function failing |

## Impact

A dropped trigger means a launch, or a **shutdown**, never happened. A session that should have stopped keeps trading.

## Diagnose

The function's logs and the DLQ's messages (each names its rule and session).

## Resolve

Do by hand what the dropped message meant (stop or launch), fix the cause, then redrive or purge the DLQ.

## Escalate

Escalate a dropped shutdown on a live session you can't stop.

## Related

[SHUTDOWN_FAILED](../alerts/SHUTDOWN_FAILED.md), [LAUNCH_FAILED](../alerts/LAUNCH_FAILED.md)
