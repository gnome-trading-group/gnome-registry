---
type: SHARD_LOG_DIGEST
summary: The day's unexpected errors across every market-data shard, by kind, with the ones new since the day before.
first_steps:
  - Look at the rows marked `new` first, then any that grew a lot.
  - Find each in the SHARD_ERRORS runbook's table.
  - A kind not in that table is new: decide whether it is a bug (fix it) or routine (lower its log level).
---

## What it means

Once a day (13:00 UTC) gnome-market-data's `ShardLogDigestFunction` reads the last two days of every region's shard log group, counts the `UNKNOWN_ERROR` and `FATAL_ERROR_EXITING` lines by kind (ids and numbers taken out, so repeats of one error are one row), and posts the last 24 h against the 24 h before. A day without any posts nothing. It catches what [SHARD_ERRORS](SHARD_ERRORS.md) doesn't: an error too rare to reach its threshold, and a new kind of error before it grows.

Each row: count today, the change from the day before (`new` if there were none), the region, the kind.

## Impact

None by itself; it is a record. Each row is an error some shard hit.

## Diagnose

- To see the lines of one kind: CloudWatch Logs Insights on `/collection/shards-<region>`, `filter @message like /<a distinctive part of the kind>/ | sort @timestamp desc`.
- The log stream (`shard/ShardContainer/<task>`) names the task; Market Data → Shards maps it to its shard.

## Resolve

- A bug: fix it in the repo the line points to (see the [SHARD_ERRORS](SHARD_ERRORS.md) table), and add its line to that table.
- Routine (handled, nothing anyone would do): lower its level where it is logged, so it leaves the digest and the shards' error count. The digest stays useful only while every row is worth reading.
- No action needed on the alert itself; it closes after a day.

## Escalate

No.

## Related

[SHARD_ERRORS](SHARD_ERRORS.md), [MarketData](../cloudwatch/MarketData.md)
