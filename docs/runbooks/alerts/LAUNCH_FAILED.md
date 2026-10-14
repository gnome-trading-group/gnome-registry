---
type: LAUNCH_FAILED
summary: The launcher couldn't launch a session.
first_steps:
  - Read the refusal reason in the alert.
  - Fix it (policies, balances, accounts).
  - Re-trigger the rule if the window hasn't passed.
---

## What it means

A launcher rule tried to launch and the registry refused or the launch failed. Common refusals: missing required risk policies, a stale balance snapshot, no ACTIVE account, a settled listing, a lease clash.

## Impact

The strategy isn't running when the rule meant it to.

## Diagnose

The alert carries the registry's message.

## Resolve

Add the missing policy, record a balance snapshot, or activate an account ([accounts](../procedures/accounts.md)); then trigger the rule again from the Launcher page.

## Escalate

No.

## Related

[accounts](../procedures/accounts.md)
