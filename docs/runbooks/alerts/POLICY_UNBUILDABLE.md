---
type: POLICY_UNBUILDABLE
summary: A risk policy can't be applied, so the session has killed its target in memory.
first_steps:
  - Find the policy in the session logs ("can't be applied").
  - Fix its parameters on Risk Policies.
  - Confirm the alert resolves.
---

## What it means

A policy's parameters couldn't be turned into a working check, so the session kills that policy's target instead. This kill exists only inside the session; it isn't a kill switch, and the registry has no record of it.

## Impact

The target (a strategy, listing or everything) doesn't trade in that session until the policy is fixed.

## Diagnose

Logs: `Risk policy N can't be applied, killing its target instead` with the error.

## Resolve

Fix the policy's parameters. The session rebuilds it on its next refresh and lifts the kill.

## Escalate

Escalate if the target is global and you can't fix the policy quickly.

## Related

[stop-or-kill](../procedures/stop-or-kill.md)
