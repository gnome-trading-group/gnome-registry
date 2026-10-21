---
type: COST_BUDGET
summary: The account's AWS spend this month is near, over, or forecast to pass its budget.
first_steps:
  - Open Cost Explorer for this account, grouped by service, for this month.
  - Find what grew, and whether something is still running that shouldn't be.
---

## What it means

The `gnome-monthly` AWS Budget (set per account in gnome-registry's config, `alerting.monthlyBudgetUsd`) crossed one of its thresholds: actual spend over 80% (WARNING) or 100% (ERROR) of the budget, or the month's forecast over 100% (WARNING).

## Impact

Money only. Billing data lags by several hours, so the spend that caused it may already have stopped, or may still be running.

## Diagnose

Cost Explorer, grouped by service and then by usage type, daily. Usual suspects: strategy session instances left running or sized up, backtest Batch jobs, Bedrock calls, log ingestion, S3 requests.

## Resolve

Stop whatever shouldn't be running. If the growth is expected, raise the budget in gnome-registry's config rather than leaving the alert to recur each month.

## Escalate

No, unless the spend is still climbing and you can't find what's driving it.

## Related

[COST_ANOMALY](COST_ANOMALY.md)
