---
type: SHARD_BALANCE_LOW
summary: A Kalshi exchange shard is low on cash.
first_steps:
  - Check the account's shard balances on Treasury.
  - Move cash onto that shard on Kalshi.
  - Confirm the alert resolves.
---

## What it means

Kalshi splits an account's cash by exchange shard, and each shard only backs orders on its own markets (0 is the
default, 1 combos, 2 crypto and commodities, 3 tennis, baseball and basketball; Kalshi adds more). Kalshi never moves
cash between shards for API orders. This shard is below the threshold set for it, or the live sessions trading its
markets have budgets larger than the cash and positions on it, even if the account's total looks fine.

## Impact

Orders on that shard's markets may be rejected for insufficient funds (`SHARD_FUNDS_REJECTED`), and new sessions
trading it are refused at launch.

## Diagnose

Treasury shows each shard's cash, what live budgets claim on it and its threshold. The listing's shard is
`sm.listing.venue_partition`. Kalshi's own view: `GET /trade-api/v2/portfolio/subaccounts/balances`.

## Resolve

If the account rebalances (its settings name shard targets), give this shard a larger share of them: the poller sets
Kalshi to them within 5 minutes, and Kalshi moves the cash within seconds after that. Otherwise, or to move cash right
away, move it from a shard with spare onto this one:

1. Check transfers are running: `GET /trade-api/v2/exchange/status`, `intra_exchange_transfers_active`.
2. With a key that has the `write::transfer` scope (or `write`), send
   `POST /trade-api/v2/portfolio/intra_exchange_instance_transfer` with `source` and `destination` both
   `event_contract`, `source_exchange_shard`, `destination_exchange_shard`, `amount` in centicents (1/10,000 of a
   dollar) and a fresh `client_transfer_id` (UUID; resend the same one to retry safely). For a subaccount, set
   `source_subaccount` and `destination_subaccount`.
3. The transfer is asynchronous; the next poll (5 minutes) shows the new split.

With rebalancing on, Kalshi moves cash moved by hand back toward the targets within seconds, so change the targets.
Moving cash between shards leaves the account's total unchanged, so record no transfer.

## Escalate

No.

## Related

[accounts](../procedures/accounts.md), [SHARD_FUNDS_REJECTED](SHARD_FUNDS_REJECTED.md), [SHARD_UNTARGETED](SHARD_UNTARGETED.md)
