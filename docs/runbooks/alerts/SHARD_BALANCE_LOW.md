---
type: SHARD_BALANCE_LOW
summary: A Kalshi exchange shard is low on cash.
first_steps:
  - Check the account's shard balances on Treasury.
  - Move cash onto that shard on Kalshi.
  - Confirm the alert resolves.
---

## What it means

Kalshi splits an account's cash by exchange shard, and each shard only backs orders on its own markets. This one is below its threshold even if the total looks fine.

## Impact

Orders on that shard's markets may be rejected for insufficient funds.

## Diagnose

Treasury shows per-shard cash and thresholds.

## Resolve

Move cash onto the shard on Kalshi. TODO(owner): steps.

## Escalate

No.

## Related

[accounts](../procedures/accounts.md)
