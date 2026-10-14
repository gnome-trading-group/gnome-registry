---
type: DRAINING_EXPOSURE
summary: A strategy holds a listing on a draining account while trading it on another.
first_steps:
  - Check the strategy's positions per account on Treasury.
  - Decide whether to unwind the old position.
  - Retire the old account once flat.
---

## What it means

A strategy still has a position on an account being drained and trades the same listing on its new account. Its limits only count the new account's position.

## Impact

Total exposure on the listing is larger than the strategy's limits see.

## Diagnose

Treasury and the strategy's positions show both.

## Resolve

Let the old position settle or unwind it by hand, then retire the account ([accounts](../procedures/accounts.md)).

## Escalate

No.

## Related

[accounts](../procedures/accounts.md)
