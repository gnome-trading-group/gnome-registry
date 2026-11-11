---
type: SHARD_FUNDS_REJECTED
summary: Kalshi is refusing orders for want of cash on one exchange shard.
first_steps:
  - Check the shard's cash on Treasury.
  - Move cash onto that shard on Kalshi.
  - Check whether the strategy was halted on the exchange.
---

## What it means

In the last 15 minutes Kalshi refused live orders on this shard's markets for insufficient funds. Each shard's cash
only backs orders on its own markets, and API orders are never funded from another shard, so this happens when the
shard is empty even if the account's total is healthy.

## Impact

The strategies named can't trade those markets. A run of these rejects trips MAX_CONSECUTIVE_REJECTS, and the OMS
then halts the strategy on the whole exchange, not only the shard.

## Diagnose

Treasury shows each shard's cash and what live budgets claim on it. The order rows are `ledger.order` with
`reject_reason = 'INSUFFICIENT_FUNDS'`; the listing's shard is `sm.listing.venue_partition`.

## Resolve

Move cash onto the shard as in [SHARD_BALANCE_LOW](SHARD_BALANCE_LOW.md), then lift any halt the reject streak
latched once the shard is funded. The alert clears 15 minutes after the last such reject.

## Escalate

No.

## Related

[SHARD_BALANCE_LOW](SHARD_BALANCE_LOW.md), [stop-or-kill](../procedures/stop-or-kill.md)
