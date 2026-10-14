---
type: ACCOUNT_READY_TO_RETIRE
summary: A draining account is empty and can be retired.
first_steps:
  - Withdraw any dust to a fresh address.
  - Retire it on Treasury.
  - Delete its secrets.
---

## What it means

The account is DRAINING with no positions, no open orders and no more than dust left.

## Impact

None.

## Diagnose

Treasury shows its balances.

## Resolve

Retire it and delete its secrets ([accounts](../procedures/accounts.md)).

## Escalate

No.

## Related

[accounts](../procedures/accounts.md)
