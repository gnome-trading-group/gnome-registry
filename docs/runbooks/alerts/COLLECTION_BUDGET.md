---
type: COLLECTION_BUDGET
summary: Streams can't be placed because the source's market-data accounts have no connections left, or their partition runs its max_shards.
first_steps:
  - The alert key is `COLLECTION_BUDGET:<source>` (accounts) or `COLLECTION_BUDGET:max_shards:<region>:<kind>:<priority>:<tier>` (shard cap); the `unplaced` label counts the streams.
  - Accounts: open Market Data → Credentials and check the source's market-data accounts (ACTIVE, connection budget).
  - Shard cap: check `max_shards` in the `market-data` Service Config against the partition's shards (Market Data → Collection → Shards).
  - Decide whether to add an account, raise the cap, or collect fewer streams.
---

## What it means

Either of two budgets ran out.

- Accounts (`COLLECTION_BUDGET:<source>`): the reconciler couldn't place streams of a signed source (Kalshi, Polymarket US): every ACTIVE market-data account is at its connection limit (the source's `connections_per_scope`, or the account's own budget), summed over every shard bound to it. Kalshi allows 200 connections per account; the reconciler keeps one spare per shard for rolls.
- Shard cap (`COLLECTION_BUDGET:max_shards:...`): the streams need a new shard in a partition (region, source kind, priority, tier) already running its `max_shards` (`market-data` Service Config). A roll or merge may run one over the cap while it moves streams; new streams in that partition wait until it is done.

## Impact

Those streams aren't collected until there is room; they count as uncovered from when they were wanted.

## Diagnose

- Accounts: the source's accounts and their budgets (Market Data → Credentials, `md.source_account`), and how many streams the rules want for the source, against `max_per_connection` × connections.
- Shard cap: the partition's shards and how full they are (`max_streams_per_shard`), and whether a roll is in progress (`roll_to_version`).

## Resolve

- Accounts: add a market-data account for the source (a separate venue account: Kalshi limits per account, not per key) and mark it ACTIVE; the next tick places the streams.
- Shard cap: raise the partition's `max_shards` (or remove its entry); the next tick starts a shard.
- Or narrow the rules wanting the source.

## Escalate

No.

## Related

[STREAM_NOT_LIVE](STREAM_NOT_LIVE.md), [accounts](../procedures/accounts.md)
