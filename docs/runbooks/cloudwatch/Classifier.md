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
| `<Worker>BatchFailures` | a queue worker (Normalize, Relationships, Notify) failing 3+ batches or idle passes an hour while it keeps running |
| RelationshipsSilent | the Relationships worker logged no pass for 2 hours: hung or not running |
| FetchCycleFailures | fetch cycles failing |
| IdentityRegressions | an event or contract identity changed in a way it shouldn't |
| VenueFeedGaps | a venue feed missing for hours |
| VenueReaderFallbacks | a market family the code readers handle (Kalshi ladders, sports totals, Hyperliquid daily binaries) stopped parsing and went to the LLM |
| PropositionDrift | the daily re-read by Claude disagreed with a code reader on a proposition field |
| PropositionExtractionFailures | 5+ Claude proposition requests failed in an hour (provider down, out of credit, unreadable answers) |
| MultiMarketSecurities | a security's listings are different markets (left from before one security per listing), so it gets no proposition |

## Impact

New events and contracts reach the security master late; settlements may be recorded late (SETTLEMENT_PENDING).
VenueReaderFallbacks costs LLM spend and makes that family's propositions less deterministic; PropositionDrift means
derived relationships for that family may be wrong until the reader or its rules text is understood.
BatchFailures and RelationshipsSilent stall whatever that worker does (new contracts, propositions, relationships);
failed batches redeliver and reach the DLQ after 3 tries. PropositionExtractionFailures leaves LLM-read contracts
without propositions until requests succeed again. MultiMarketSecurities only costs those securities their
relationships.

## Diagnose

The worker's ECS logs; the queue's messages. For the proposition alarms, the Relationships worker's logs name the
family and security (`venue reader fell back: family=...`, `proposition drift: family=... field=...`); replay the
stored sources with `poetry run eval-propositions --stored` in gnome-classifier to see which wording changed.
For BatchFailures, the worker's logs carry the traceback after `process_batch failed` or `on_idle failed`. For
RelationshipsSilent, check the service is running a task, then the last log lines (a hang shows as a gap after a
pass started). For PropositionExtractionFailures, the error follows `Proposition request for N contracts failed`
(credit, rate limit, or an answer that is not the schema's JSON). For MultiMarketSecurities, the log line names the
security; `sm.listing` shows its listings.

## Resolve

Fix the worker, then redrive the DLQ. A hung Relationships worker: stop its task so ECS starts a new one. Extraction
failures from credit or an outage: top up or wait (or turn `proposition_llm_enabled` off); the backlog reads the
contracts once requests succeed. Multi-market securities: split them so each market has its own security. For the
proposition alarms, update the reader for the venue's new wording (or
fix the reader the drift exposed), bump `EXTRACTOR_VERSION`, and let the classifier re-derive.

## Escalate

No, unless settlements are blocked on it.

## Related

[SETTLEMENT_PENDING](../alerts/SETTLEMENT_PENDING.md)
