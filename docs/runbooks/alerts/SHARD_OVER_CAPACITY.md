---
type: SHARD_OVER_CAPACITY
summary: A market-data shard has carried more published streams or collected records per second than its tier's cap for 10 minutes; its latency tail may be past target.
first_steps:
  - Read the title: published and records/s against the tier's caps (labels `published`, `max_published`, `records_per_second`, `max_records_per_second`).
  - Check the reconciler's log for "Relieving shard" or "Would relieve shard" (dry run) lines about it.
  - If relief can't move anything ("no stream free to move", or every stream with no room), look at the partition's `max_shards`.
---

## What it means

Each shard tier has caps in the `market-data` Service Config `shard_caps`, set below the load at which load tests saw its latency targets fail:

| Tier | Instance | max_streams | max_published | max_records_per_second |
|---|---|---|---|---|
| standard | r7a.medium | 900 | 400 | 2,000 |
| low_latency | r7a.large | 900 | 300 | 50,000 |

Placement never puts a stream on a shard that would go over a cap. A shard can still end up over one: a session leases streams already on it (a lease never moves a placed stream), or its markets get busier. Shards report each stream's `records_per_second` (the last minute) in their status; published streams are those an active lease wants. The reconciler raises this alert once a shard has been over the published or rate cap for `alerts.over_capacity_minutes` (10), and resolves it once it isn't.

Host CPU is not a capacity signal: shard agents spin, so a quiet shard reads busy. Judge only by the caps.

## Impact

Over the published cap, sessions reading from the shard may see records later than usual (the Aeron driver's sweep grows with each publication). Over the rate cap, the single-core tail grows on standard shards. Nothing is lost; data keeps being written.

## Diagnose

- Relief (Service Config `rebalance`): once over for `relieve_after_minutes` (10), the reconciler hands streams off make-before-break onto shards left at most `relieve_target_fill` (0.8) of their caps, or onto a new shard within `max_shards`, until the shard is at most 0.8 of the cap it was over. Unleased streams go first, busiest first; leased ones last. At most `max_moves_per_tick` (25) streams move a tick, `max_leased_moves_per_tick` (3) of them leased. A shard touched by a merge or relief waits `shard_cooldown_minutes` (30), a moved stream `stream_cooldown_minutes` (60). Relief waits while a roll, merge or hand-off is under way.
- `rebalance.dry_run` true: relief only logs "Would relieve shard ...". The alert stays up.
- Nothing moves and the log says no room: the partition is at `max_shards`, or account budgets (`COLLECTION_BUDGET`) leave no shard a stream could go to.

## Resolve

- Dry run on: if the logged moves look right, set `rebalance.dry_run` false.
- At `max_shards`: raise it for the partition, and relief starts a shard on its next try.
- Many leased streams in one partition on low_latency: past about 300, an r7a.xlarge with a dedicated LATENCY driver thread is the next step; the caps would need new load-test numbers first.
- Never raise a cap to quiet the alert without load-test evidence for the new number.

## Escalate

No. If sessions on the shard show `MARKET_DATA_BAD` alongside it, say so in the channel.

## Related

[COLLECTION_BUDGET](COLLECTION_BUDGET.md), [SHARD_ERRORS](SHARD_ERRORS.md), [COLLECTOR_SHARD_DOWN](COLLECTOR_SHARD_DOWN.md)
