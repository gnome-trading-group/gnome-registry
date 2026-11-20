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
| RegistryDatabase EBS byte / IO balance | the burstable database has spent over half its EBS burst balance: some reader reads far more than usual, and once it is spent every read waits on the baseline (the API, alerting and syncs time out together). Find the reader: `log_min_duration_statement` on the parameter group for an hour, or the per-table block reads in `pg_statio_user_tables` |
| ExchangeSync fault | the security-master sync (every 15 minutes) failed |
| SettlementSweeper fault | the 5-minute sweeper failed to book a settled position (it fails on purpose when a booking fails) |
| VenuePoller fault | the 5-minute balance poller crashed (a failed account read is an ERROR snapshot instead, seen as RECON_STALE) |
| MetadataSync `<kind>` fault | a run of a venue metadata kind (`specs`, `incentives`) couldn't read a venue or had a write refused; the log line `The <kind> sync (<mode>) for <venue> failed` names it. Specs stay as they were (a new listing stays untradable: LISTING_SPEC_MISSING after 5 minutes); incentive programs miss their changes (paper and backtest reward estimates see none) |
| MetadataSync `<kind>-<venue>-<mode>` heartbeat | no healthy run of that kind, venue and mode for three of its periods (two days for a daily one): failing, refused, or not running (a rule disabled, the Lambda throttled). Same consequences as a fault |
| MetadataSync `<kind>-<venue>` NoSnapshot | a sweep found no snapshot in `gnome-registry-cache-<stage>/<kind>/` and reconciled to make one: expected once after a deploy or a lost bucket object, a problem if it repeats (the sweep can't save: check its S3 grant) |
| MetadataSync specs-KALSHI ChangedMissed | Kalshi's metadata-updated read missed a listing whose spec moved: Kalshi doesn't mark that change as a metadata update, so the changed read can't replace the full read. The warning names the listings |
| MetadataSync specs-refresh fault, dead-letter queue | a shard's tick-change notice couldn't be processed, or its venue never showed the new tick in five tries; the next reconcile records any change, dated then. Read the message in `listing-spec-refresh-dlq.fifo`, then delete it |
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
