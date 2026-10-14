---
type: AGENT_EXITED
summary: Part of a running session has stopped; the session is no longer whole.
first_steps:
  - Open the session page to see which agent exited.
  - If live: check the venue for resting orders.
  - Stop and relaunch the session.
---

## What it means

One of the session's agents (OMS, strategy, gateway reader, ledger…) has closed while the session still says it's running.

## Impact

Whatever that agent did (trading, cancelling, recording) has stopped.

## Diagnose

Logs around the agent's exit ([inspect-session](../procedures/inspect-session.md)).

## Resolve

Stop the session and relaunch it once the cause is understood.

## Escalate

Escalate if the OMS or an order gateway exited on a live session and the venue can't be checked.

## Related

[inspect-session](../procedures/inspect-session.md), [check-venue-orders](../procedures/check-venue-orders.md)
