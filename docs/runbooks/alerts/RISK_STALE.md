---
type: RISK_STALE
summary: The session can't refresh its risk policies; it refuses new orders.
first_steps:
  - Check the registry API and database (/system).
  - Open the session page and its logs.
  - If it persists, stop the session.
---

## What it means

The session's risk policies haven't refreshed from the registry for over 30 seconds (`risk.stale.after.ms`), so the OMS refuses new orders. Resting orders are not cancelled.

## Impact

The strategy can't trade, and kill switches can't reach it while stale.

## Diagnose

Usually the registry is unreachable ([registry-down](../procedures/registry-down.md)). Logs show RiskSyncAgent refresh failures.

## Resolve

Restore the registry; the session resumes on its next refresh and the alert resolves.

## Escalate

Escalate if the registry is down with live orders resting.

## Related

[registry-down](../procedures/registry-down.md), [inspect-session](../procedures/inspect-session.md)
