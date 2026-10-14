---
type: RISK_UNGUARDED
summary: A live session is missing a required risk policy; it refuses every order.
first_steps:
  - Open Risk Policies and check this strategy's coverage.
  - Add the missing policy for each traded listing.
  - Confirm the alert resolves.
---

## What it means

A live session needs MAX_COMMITTED_CAPITAL, MAX_TOTAL_PNL_LOSS, MAX_POSITION and MAX_CONSECUTIVE_REJECTS covering every listing it trades. One is missing (deleted or disabled after launch), so the OMS refuses everything (`RISK_UNGUARDED`).

## Impact

The strategy isn't trading. It's safe, but idle.

## Diagnose

The logs' `RISK_UNGUARDED` line names the gap. Risk Policies' history shows who removed what.

## Resolve

Restore the policy; the session picks it up on its next refresh.

## Escalate

Escalate only if nobody knows why the policy was removed.

## Related

[stop-or-kill](../procedures/stop-or-kill.md)
