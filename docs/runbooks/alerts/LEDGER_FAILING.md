---
type: LEDGER_FAILING
summary: The session's ledger writes are failing; the OMS halts every strategy in it.
first_steps:
  - Open the session page; check the ledger health and logs.
  - Check the registry API and database (/system).
  - If live: check the venue for resting orders.
---

## What it means

The session's heartbeat says its writes to the registry's ledger keep failing (5xx or no response). Ten seconds behind, the OMS latches every strategy in the session and cancels their orders (`LEDGER_FAILING_HALTED`).

## Impact

Fills the ledger hasn't recorded leave positions it can't vouch for; recovery marks them for review.

## Diagnose

Logs: `LEDGER_WRITE_FAILED` / `LEDGER_FENCED` with the status. A 4xx is a fence (check the session's status and leases); a 5xx is the registry ([registry-down](../procedures/registry-down.md)).

## Resolve

Fix the registry or stop the session. Positions the ledger missed come back as NEEDS_REVIEW and must be adjusted before the strategy trades them again.

## Escalate

Escalate if fills may have been lost on a live session.

## Related

[registry-down](../procedures/registry-down.md), [inspect-session](../procedures/inspect-session.md), [NEEDS_REVIEW](NEEDS_REVIEW.md)
