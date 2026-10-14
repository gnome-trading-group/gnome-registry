---
type: STOP_STUCK
summary: A session has been stopping for 10 minutes and hasn't finished.
first_steps:
  - Check its instance on /system → Trading fleet.
  - Terminate the instance from the EC2 console if it's still running.
  - If live: check the venue.
---

## What it means

The session is STOPPING, but EC2 hasn't reported its instance terminated. The stop terminates the instance a few seconds after killing it; something stopped that.

## Impact

Its listings stay leased (no new session can take them) and the instance may still be running.

## Diagnose

Look the instance up in EC2 in its launch region. A failed terminate is in the registry launcher Lambda's logs.

## Resolve

Terminate the instance; the monitor then marks the session STOPPED.

## Escalate

Escalate if the instance can't be terminated.

## Related

[stop-or-kill](../procedures/stop-or-kill.md)
