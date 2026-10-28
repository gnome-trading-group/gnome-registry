---
type: COLLECTION_BUDGET
summary: Streams can't be placed because the source's market-data accounts have no connections left.
first_steps:
  - The alert key is `COLLECTION_BUDGET:<source>`; the `unplaced` label counts the streams.
  - Open Market Data → Credentials and check the source's market-data accounts (ACTIVE, connection budget).
  - Decide whether to add an account or collect fewer streams.
---

## What it means

The reconciler couldn't place streams of a signed source (Kalshi, Polymarket US): every ACTIVE market-data account is at its connection limit (the source's `connections_per_scope`, or the account's own budget), summed over every shard bound to it. Kalshi allows 200 connections per account; the reconciler keeps one spare per shard for rolls.

## Impact

Those streams aren't collected until there is room; they count as uncovered from when they were wanted.

## Diagnose

- The source's accounts and their budgets (Market Data → Credentials, `md.source_account`).
- How many streams the rules want for the source, against `max_per_connection` × connections.

## Resolve

- Add a market-data account for the source (a separate venue account: Kalshi limits per account, not per key) and mark it ACTIVE; the next tick places the streams.
- Or narrow the rules wanting the source.

## Escalate

No.

## Related

[STREAM_NOT_LIVE](STREAM_NOT_LIVE.md), [accounts](../procedures/accounts.md)
