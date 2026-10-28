---
type: STREAM_NOT_LIVE
summary: Streams a rule wants have not been collected for 10 minutes, in one source and region.
first_steps:
  - The alert key is `STREAM_NOT_LIVE:<source>:<region>`; its title counts the streams.
  - Open Market Data → Shards and filter to that source and region; look for streams not LIVE, or none placed.
  - If a shard is down too, follow COLLECTOR_SHARD_DOWN first.
---

## What it means

Streams wanted by a collection rule have been uncovered for 10 minutes: no fresh status from their shard shows them LIVE, SUSPECT or EMPTY. Causes: not placed yet (no shard has room and none could start), the shard is down, the market won't subscribe (the venue refuses it, the account lacks access), or the stream's connection keeps failing.

## Impact

Those minutes are missing from the final bucket; a gap is recorded per stream once coverage resumes. Live trading is unaffected.

## Diagnose

- Shards page: the streams' state on their shard (SUBSCRIBING, FAILED, RECONNECTING) and the connection lines in the shard's status.
- The shard's logs, `/collection/shards-<region>`: "Can't start stream" lines name the cause; a failed start retries every 5 minutes.
- Unplaced streams: a COLLECTION_BUDGET alert, or a reconciler log line "can't be placed".

## Resolve

- Unplaced: see COLLECTION_BUDGET, or check the source is collectable (`md.source` capacity columns set).
- A market the venue refuses: retire it from the rule.
- A bad release: roll back with `roll_to_version` in Service Config (`market-data`).
- The alert resolves when the streams are covered again.

## Escalate

No.

## Related

[STREAM_STALE](STREAM_STALE.md), [COLLECTOR_SHARD_DOWN](COLLECTOR_SHARD_DOWN.md), [COLLECTION_BUDGET](COLLECTION_BUDGET.md)
