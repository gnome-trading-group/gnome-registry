---
type: LEASED_STREAM_UNPLACED
summary: A stream a session leased has had no shard for 5 minutes, so that session is about to fail to start or has lost its data.
first_steps:
  - The alert names the source and region; the `streams` label lists the stream ids.
  - Open Market Data → Collection → Shards for that region and check for a shard starting, failing or out of capacity.
  - Check the session waiting on it (its config's listings and `streams`): it fails to start 10 minutes after launch.
---

## What it means

The launcher leases every stream a paper session reads (its listings' book streams and its `streams`), and the reconciler places them on shards like any rule's streams, at the lease's priority (paper: research, on Spot). This stream has wanted a shard for 5 minutes (a cold start takes 3-5) and has none, for one of:

- no shard in its partition had room and none could be started (capacity, or the partition is at its `max_shards`);
- the source has no market-data account with connections left;
- the stream can never be collected: its listing ended (inactive) or the registry doesn't know it. The alert's source and region are then the registry's, or `unknown` for a stream it doesn't know.

## Impact

A session waiting on the stream to go live doesn't start; it fails after `market.data.start.timeout.seconds` (10 minutes by default) with "Market data never went live on shards". A running session whose stream lost its shard has had that stream flagged bad data since, so its OMS refuses new orders on that listing.

## Diagnose

- The reconciler's log for the tick: placement failures name the reason (no capacity, account budget, scale-out failing).
- [COLLECTION_BUDGET](COLLECTION_BUDGET.md) keyed `COLLECTION_BUDGET:max_shards:...` firing for the stream's partition means the `max_shards` cap stopped a new shard.
- The stream in the registry (`GET /streams?streamIds=<id>`): `active` false means its listing ended.
- The region's capacity provider and ASG (Spot capacity for research shards).
- [COLLECTION_BUDGET](COLLECTION_BUDGET.md) firing for the same source means the accounts are full.

## Resolve

- Capacity: let the ASG scale or raise its maximum; a Spot shortage clears on its own or by moving the partition to on-demand. A `max_shards` cap: raise it in the `market-data` Service Config.
- An ended or unknown stream: nothing will place it; stop the session and relaunch without it.
- Account budget: see [COLLECTION_BUDGET](COLLECTION_BUDGET.md).
- A session that failed to start can be launched again once the stream is placed.

## Escalate

No: only paper sessions lease streams; live sessions still open their own feeds.

## Related

[COLLECTION_BUDGET](COLLECTION_BUDGET.md), [MARKET_DATA_BAD](MARKET_DATA_BAD.md), [STREAM_NOT_LIVE](STREAM_NOT_LIVE.md)
