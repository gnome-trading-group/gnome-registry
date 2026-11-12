---
type: REWARD_UNALLOCATED
summary: A venue reward couldn't be given to the strategies that earned it, so it stays firm-level.
first_steps:
  - Open the transfer on Treasury → Transfers to see its program and venue.
  - Check whether any live strategy traded or quoted on that account when it was earned.
---

## What it means

Liquidity rewards and maker and taker rebates are given to the strategies that earned them, from the venue's
per-market breakdown of the payout and the ledger's orders and fills. For this one the breakdown never arrived or
never added up to what was paid, or no strategy on the account quoted or traded the markets it was paid for.

## Impact

Strategy PnL is missing this reward; firm PnL still has it, as non-trading income.

## Diagnose

- Polymarket Intl maker rebates: `/rebates/current?date=<day before payout>&maker_address=<funder>` should add up to
  the payout.
- Polymarket Intl liquidity rewards: `/rewards/user` needs the wallet's CLOB API keys in its read secret.
- Polymarket US liquidity: `/v1/incentives/earnings` rows since the previous payout.
- Kalshi: the credit's reason should name the market.

## Resolve

Nothing has to be done for the money. If the cause is fixable (missing CLOB keys, a reader bug), fix it; transfers
already marked FAILED stay firm-level. The alert clears two weeks after the payment.

## Escalate

No.

## Related

[accounts](../procedures/accounts.md)
