---
type: SHARD_UNTARGETED
summary: Kalshi's rebalancing sweeps cash off a shard live sessions trade.
first_steps:
  - Check the account's rebalancing targets on Treasury.
  - Give the shard a share of the targets.
  - Confirm the alert resolves.
---

## What it means

The account rebalances its cash between Kalshi shards, and its targets give nothing to a shard where live sessions
trade. Every 10 seconds Kalshi moves that shard's free cash (what resting orders don't hold) to the shards the targets
name, so new orders there will find no cash.

## Impact

Orders on that shard's markets are refused for insufficient funds (`SHARD_FUNDS_REJECTED`) once their resting
collateral is used up. New sessions trading it are refused at launch.

## Diagnose

Treasury shows each shard's target, what Kalshi is set to and what live budgets claim on it.

## Resolve

In the account's settings, give the shard a share of the rebalancing targets in proportion to the budgets trading it,
keeping the total at 100. The poller sets Kalshi to them on its next run (5 minutes).

## Escalate

No.

## Related

[SHARD_BALANCE_LOW](SHARD_BALANCE_LOW.md), [REBALANCE_DRIFT](REBALANCE_DRIFT.md)
