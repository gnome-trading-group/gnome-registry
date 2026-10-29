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
| VenueReaderFallbacks | a market family the code readers handle (Kalshi ladders, sports totals, Hyperliquid daily binaries) stopped parsing and went to the LLM |
| PropositionDrift | the daily re-read by Claude disagreed with a code reader on a proposition field |

## Impact

New events and contracts reach the security master late; settlements may be recorded late (SETTLEMENT_PENDING).
VenueReaderFallbacks costs LLM spend and makes that family's propositions less deterministic; PropositionDrift means
derived relationships for that family may be wrong until the reader or its rules text is understood.

## Diagnose

The worker's ECS logs; the queue's messages. For the proposition alarms, the Relationships worker's logs name the
family and security (`venue reader fell back: family=...`, `proposition drift: family=... field=...`); replay the
stored sources with `poetry run eval-propositions --stored` in gnome-classifier to see which wording changed.

## Resolve

Fix the worker, then redrive the DLQ. For the proposition alarms, update the reader for the venue's new wording (or
fix the reader the drift exposed), bump `EXTRACTOR_VERSION`, and let the classifier re-derive.

## Escalate

No, unless settlements are blocked on it.

## Related

[SETTLEMENT_PENDING](../alerts/SETTLEMENT_PENDING.md)
