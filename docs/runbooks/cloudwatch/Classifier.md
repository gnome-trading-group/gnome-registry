---
type: Classifier
summary: A classifier alarm fired: a queue backing up, a worker unhealthy, or a venue feed gap.
first_steps:
  - Open the alarm to see which part.
  - Check /system → Queues and the worker's ECS logs.
  - Redrive any DLQ messages once fixed.
---

## What it means

Alarms named `Classifier-…`:

| Alarm | Fires when |
|---|---|
| `<Queue>` message age | Contracts, Entities, Embeddings or Slack queue backing up |
| `<Queue>Dlq` | messages failed repeatedly |
| `<Worker>Worker` memory | a worker near its memory limit |
| `<Worker>WorkerRestarts` | a worker restarting repeatedly |
| FetchCycleFailures | fetch cycles failing |
| IdentityRegressions | an event or contract identity changed in a way it shouldn't |
| VenueFeedGaps | a venue feed missing for hours |

## Impact

New events and contracts reach the security master late; settlements may be recorded late (SETTLEMENT_PENDING).

## Diagnose

The worker's ECS logs; the queue's messages.

## Resolve

Fix the worker, then redrive the DLQ.

## Escalate

No, unless settlements are blocked on it.

## Related

[SETTLEMENT_PENDING](../alerts/SETTLEMENT_PENDING.md)
