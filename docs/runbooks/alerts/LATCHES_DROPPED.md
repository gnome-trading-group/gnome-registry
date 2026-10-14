---
type: LATCHES_DROPPED
summary: The OMS halted something it couldn't record in the registry.
first_steps:
  - Open the session logs; look for STRATEGY_LATCHED lines.
  - Turn on matching kill switches by hand.
  - Stop the session if you can't tell what was halted.
---

## What it means

The OMS keeps automatic halts in a fixed-size buffer until they're posted as kill switches. It overflowed, so some halts were never recorded.

## Impact

The OMS still enforces those halts in memory, but nothing outside the session knows about them, and a relaunch would forget them.

## Diagnose

Every `STRATEGY_LATCHED` line in the logs is a halt; compare them with the kill switches on Risk Policies.

## Resolve

Turn on any missing kill switches, then stop and relaunch the session once the cause of the storm is fixed.

## Escalate

Escalate: this means many halts in a short time.

## Related

[inspect-session](../procedures/inspect-session.md), [stop-or-kill](../procedures/stop-or-kill.md)
