---
type: ALLOCATION_EXCEEDS_BALANCE
summary: A venue account's live budgets add up to more than it holds.
first_steps:
  - Check allocations on Treasury.
  - Fund the account or lower budgets.
  - Confirm the alert resolves.
---

## What it means

The budgets of the account's active live sessions (plus capital tied up by positions no session holds) exceed its equity less its buffer.

## Impact

Strategies may try to commit money that isn't there and hit insufficient-funds rejects.

## Diagnose

Treasury shows each session's budget against the account's base.

## Resolve

Deposit, stop a session, or lower MAX_COMMITTED_CAPITAL.

## Escalate

No.

## Related

[accounts](../procedures/accounts.md)
