---
type: COLLECTOR_SHARD_DOWN
summary: A market-data collection shard has had no healthy task for 5 minutes.
first_steps:
  - Open the shard on the controller's Market Data → Shards page (its id is in the alert key, `COLLECTOR_SHARD_DOWN:<shard>`).
  - Read its task logs there, or `/collection/shards-<region>` in CloudWatch.
  - Check the ECS service `shard-<shard>` in `CollectionCluster-<region>` for stopped-task reasons.
---

## What it means

The reconciler (gnome-market-data) found no status from any of the shard's tasks for 5 minutes. A task writes one every 15 s to `s3://gnome-market-data-metadata-<stage>/collection/shards/<shard>/status/`. Either no task is running (it can't be placed, the image or orchestrator jar didn't download, it crash-loops) or the task runs but can't write its status.

## Impact

Every stream on the shard is uncovered: those minutes are missing from the final bucket and recorded as gaps once coverage resumes. Live trading is unaffected.

## Diagnose

- ECS service events and stopped tasks' `stoppedReason`: no capacity (Spot unavailable, the capacity provider at its max), an image pull or jar download failure, out of memory, or the `/health` check failing (agent stalled 30 s, an upload hung 5 min).
- The shard's log group `/collection/shards-<region>`, stream `shard/ShardContainer/<task>`: the last lines before it stopped.
- If tasks run but no status lands: the task role's `s3:PutObject` on the metadata bucket, or the network path to S3.

## Resolve

- Capacity: wait for Spot to return or raise the capacity provider's max (CollectionRegionalStack). A production shard runs on demand.
- A bad orchestrator release: set `roll_to_version` in the controller's Service Config (`market-data`) to the last good version; the reconciler rolls shards onto it.
- Otherwise fix the cause; ECS keeps replacing the task, and the alert resolves on the first healthy status.

## Escalate

No: collection is behind trading. Raise it in the channel if a whole region is down.

## Related

[STREAM_NOT_LIVE](STREAM_NOT_LIVE.md), [MarketData](../cloudwatch/MarketData.md)
