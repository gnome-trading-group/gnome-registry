---
type: REBALANCE_DRIFT
summary: Kalshi isn't rebalancing a venue account's cash between shards as its targets say.
first_steps:
  - Read the alert's detail for Kalshi's error.
  - Check the account's read key has the write::transfer scope.
  - Confirm the alert resolves on the next poll.
---

## What it means

The account's shard rebalancing targets (Treasury, account settings) differ from what Kalshi is set to, after the
venue poller tried to set them. The poller sets them with the account's read key, which needs the `read` and
`write::transfer` scopes; a 401 or 403 in the detail usually means the key lacks `write::transfer`.

## Impact

Kalshi keeps rebalancing toward its old targets, or not at all, so shards live sessions trade can run dry
(`SHARD_BALANCE_LOW`) and their orders get refused (`SHARD_FUNDS_REJECTED`).

## Diagnose

The detail names Kalshi's error, or what it is set to against what the account wants. The latest snapshot's
`rebalance_targets` holds what the poller found; the poller's logs are under the VenuePoller Lambda.

## Resolve

- Scope: create a new Kalshi key with `read` and `write::transfer` (never `write`, which can trade) and set it with
  **Update credentials** on the account's menu.
- Kalshi refusing the targets themselves (400): fix them in the account settings; they must add up to 100.
- Transfers paused by Kalshi (`intra_exchange_transfers_active` false on `GET /trade-api/v2/exchange/status`): wait.

## Escalate

No.

## Related

[accounts](../procedures/accounts.md), [SHARD_BALANCE_LOW](SHARD_BALANCE_LOW.md)
