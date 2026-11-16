---
type: SHARD_OVER_CAPACITY
summary: A market-data shard's load (published streams and collected records per second together) has been over its tier's caps for 10 minutes; its latency tail may be past target.
first_steps:
  - Read the title: its load as a percentage, and the published streams and records/s behind it (labels `load_percent`, `published`, `max_published`, `records_per_second`, `max_records_per_second`).
  - Check the reconciler's log for "Relieving shard" or "Would relieve shard" (dry run) lines about it.
  - If relief can't move anything ("no stream free to move", or every stream with no room), look at the partition's `max_shards`.
---

## What it means

Each shard tier has caps in the `market-data` Service Config `shard_caps`. Published streams and collected records per second use the same cores, so they count together as the shard's load:

    load = published / max_published + records_per_second / max_records_per_second   (at most 1)

Load tests on a standard shard measured the two adding up (network p99 about 127 us + 2.1 us per published stream + 0.15 us per record/s), and each cap is the most of it alone, with a margin:

| Tier | Instance | max_streams | max_published | max_records_per_second |
|---|---|---|---|---|
| standard | r7a.medium | 900 | 300 | 4,500 |
| low_latency | r7a.large | 900 | 300 | 50,000 |

So a standard shard publishing 30 streams may take about 4,000 records/s, one publishing 150 about 2,250, one publishing 300 none.

Placement never puts a stream on a shard that would take its load over 1 (or its streams over `max_streams`). A shard can still end up over: a session leases streams already on it (a lease never moves a placed stream), or its markets get busier. Shards report each stream's `records_per_second` (the last minute) in their status; published streams are those an active lease wants. The reconciler raises this alert once a shard's load has been over 1 for `alerts.over_capacity_minutes` (10), and resolves it once it isn't.

Host CPU is not a capacity signal: shard agents spin, so a quiet shard reads busy. Judge only by the caps.

## Impact

Sessions reading from the shard may see records later than usual: the Aeron driver's sweep grows with each publication and the single core's work with each record, and on a standard shard the tail passes target once the two together pass the caps. Nothing is lost; data keeps being written.

## Diagnose

- Relief (Service Config `rebalance`): once over for `relieve_after_minutes` (10), the reconciler hands streams off make-before-break onto shards left at most `relieve_target_fill` (0.8) load, or onto a new shard within `max_shards`, until the shard's load is at most 0.8. Unleased streams go first, busiest first (no session sees those move); leased ones last, the one taking most off the load first. At most `max_moves_per_tick` (25) streams move a tick, `max_leased_moves_per_tick` (3) of them leased. A shard touched by a merge or relief waits `shard_cooldown_minutes` (30), a moved stream `stream_cooldown_minutes` (60). Relief waits while a roll, merge or hand-off is under way.
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
