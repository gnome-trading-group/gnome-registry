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
- `InventoryProcessorLambda-…`, `QualityCheckLambda-…`: any fault in that function.
- `market-data-<queue>-queue-DLQ-…` / `-Queue-Message-Age-…`: work dead-lettered, or a consumer falling behind.

## Impact

Reconciler failing: running shards keep collecting what they were assigned, but nothing changes and collection alerts stop. Others: historical datasets fall behind; live trading is unaffected.

## Diagnose

- Reconciler: `/aws/lambda/<Stage>-MarketDataReconcilerStack-Reconciler-v1`. A whole-tick failure is usually DynamoDB, S3, the registry or the controller (Service Config) being unreachable; a single shard's ECS error is logged ("Shard … failed this tick") and doesn't fail the tick.
- Others: the function's logs; its queue's age and DLQ on /system → Queues.

## Resolve

- Reconciler: fix the dependency or roll back the market-data release; the next tick catches up on everything.
- Others: fix and redrive the failed messages from the DLQ.

## Escalate

No.

## Related

[COLLECTOR_SHARD_DOWN](../alerts/COLLECTOR_SHARD_DOWN.md), [Controller](Controller.md)
