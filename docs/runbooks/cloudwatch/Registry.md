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
| ExchangeSync fault | the security-master sync (every 15 minutes) failed |
| SettlementSweeper fault | the 5-minute sweeper failed to book a settled position (it fails on purpose when a booking fails) |
| VenuePoller fault | the 5-minute balance poller crashed (a failed account read is an ERROR snapshot instead, seen as RECON_STALE) |
| IncentiveSync fault | the 15-minute incentive program sync couldn't read a venue or post to the registry (paper and backtest reward estimates then see no new or changed programs) |
| SpecSync fault | a spec sync pass (every 15 minutes in full, every minute for listings with no spec) couldn't read a venue or post to the registry; specs stay as they were, and a new listing stays untradable (LISTING_SPEC_MISSING after 5 minutes) |
| SpecRefresh fault, dead-letter queue | a shard's tick-change notice couldn't be processed, or its venue never showed the new tick in five tries; the next full pass records any change, dated then. Read the message in `listing-spec-refresh-dlq.fifo`, then delete it |
| StrategySessionMonitor fault | session status updates from EC2 events failed |
| SamplesApi 5xx | the samples API failed posts or reads; gateways and shards keep their samples and resend, up to their buffers |
| SamplePartitions fault | the hourly upkeep of `ops.sample`'s daily partitions failed. Partitions are made 3 days ahead, so samples keep landing for days; past that, sessions' samples are dropped (their heartbeats still count). Once the cause is fixed, invoke the `SamplesApiStack` partitions Lambda by hand rather than wait for the hour |

## Impact

The API and database are the control plane: sessions refresh risk and write their ledger through them. The scheduled jobs only delay bookkeeping.

## Diagnose

The function's CloudWatch logs (`/aws/lambda/<function>`); for the database, RDS metrics and Performance Insights.

## Resolve

Fix the failing part; the alarm resolves when its metric recovers. For an outage, see [registry-down](../procedures/registry-down.md).

## Escalate

Escalate a database or API outage with live sessions.

## Related

[registry-down](../procedures/registry-down.md), [SETTLEMENT_BLOCKED](../alerts/SETTLEMENT_BLOCKED.md), [RECON_STALE](../alerts/RECON_STALE.md), [LISTING_SPEC_MISSING](../alerts/LISTING_SPEC_MISSING.md)
