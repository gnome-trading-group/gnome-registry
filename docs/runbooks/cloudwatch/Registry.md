---
type: Registry
summary: A registry alarm fired: its API, database, or a scheduled job.
first_steps:
  - Open the alarm and see which part it names.
  - Check /system → Services, Databases and Scheduled jobs.
  - Read that function's logs in CloudWatch.
---

## What it means

Alarms named `Registry-…`:

| Alarm | Fires when |
|---|---|
| RegistryApi 5xx | the API's server errors rise |
| RegistryDatabase storage / CPU | the database is filling up or busy |
| ExchangeSync fault | the hourly security-master sync failed |
| SettlementSweeper fault | the 5-minute sweeper failed to book a settled position (it fails on purpose when a booking fails) |
| VenuePoller fault | the 5-minute balance poller crashed (a failed account read is an ERROR snapshot instead, seen as RECON_STALE) |
| StrategySessionMonitor fault | session status updates from EC2 events failed |

## Impact

The API and database are the control plane: sessions refresh risk and write their ledger through them. The scheduled jobs only delay bookkeeping.

## Diagnose

The function's CloudWatch logs (`/aws/lambda/<function>`); for the database, RDS metrics and Performance Insights.

## Resolve

Fix the failing part; the alarm resolves when its metric recovers. For an outage, see [registry-down](../procedures/registry-down.md).

## Escalate

Escalate a database or API outage with live sessions.

## Related

[registry-down](../procedures/registry-down.md), [SETTLEMENT_BLOCKED](../alerts/SETTLEMENT_BLOCKED.md), [RECON_STALE](../alerts/RECON_STALE.md)
