---
type: AGENT_STALLED
summary: A hot-path agent has made no progress for a while.
first_steps:
  - Open the session page; check which agent and for how long.
  - Take a thread dump if it's still stuck.
  - Stop the session if it doesn't recover.
---

## What it means

A hot-path agent (OMS, strategy, reader) hasn't completed a loop for over 2 seconds, on two ticks running.

## Impact

Market data, orders or fills for that agent are delayed; a stuck OMS can't cancel.

## Diagnose

A thread dump (`kill -3`) shows where it's stuck ([inspect-session](../procedures/inspect-session.md)). GC pauses show in the logs.

## Resolve

If it doesn't recover, stop the session.

## Escalate

Escalate if a live OMS is stuck and orders are resting.

## Related

[inspect-session](../procedures/inspect-session.md)
