---
type: MarketData
summary: A market-data Lambda failed, or the collection reconciler keeps failing.
first_steps:
  - Open the alarm to see which function.
  - Read its CloudWatch logs.
  - For the reconciler (`MarketData--ReconcilerLambda-…`), check Market Data → Shards still updates.
---

## What it means

Alarms named `MarketData-…`:

- `ReconcilerLambda-Fault-Count-Error` (RECONCILER_FAILING): 3 or more failed reconciler ticks in the alarm's period. A tick that fails is retried by the next minute's, so this means it keeps failing: nothing is placed, handed off, rolled, scaled down or alerted on.
- `ShardLogDigestLambda-Fault-Count-Error` (DIGEST_FAILING): the daily [SHARD_LOG_DIGEST](../alerts/SHARD_LOG_DIGEST.md) failed. It posts nothing on a quiet day, so without this alarm a failing digest would look like one.

## Impact

Reconciler failing: running shards keep collecting and serving what they were assigned, but nothing changes and collection alerts stop: a new session's leased streams aren't placed, so it can't start. Digest failing: no daily digest; [SHARD_ERRORS](../alerts/SHARD_ERRORS.md) still fires.

## Diagnose

- Reconciler: `/aws/lambda/<Stage>-MarketDataReconcilerStack-Reconciler-v1`. A whole-tick failure is usually DynamoDB, S3, the registry or the controller (Service Config) being unreachable; a single shard's ECS error is logged ("Shard … failed this tick") and doesn't fail the tick.

- Digest: its function's log (`/aws/lambda/<Stage>-MarketDataMonitoringStack-ShardLogDigestFunction…`): a Logs Insights query that failed or timed out, or `PutEvents` refused.

## Resolve

- Reconciler: fix the dependency or roll back the market-data release; the next tick catches up on everything.
- Digest: fix the cause; invoke the function by hand to post today's.

## Escalate

No.

## Related

[COLLECTOR_SHARD_DOWN](../alerts/COLLECTOR_SHARD_DOWN.md), [Controller](Controller.md)
