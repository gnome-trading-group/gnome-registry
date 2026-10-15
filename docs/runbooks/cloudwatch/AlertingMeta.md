---
type: AlertingMeta
summary: Alerting itself is broken; other alerts may not be reaching anyone.
first_steps:
  - Open /system → Services and Scheduled jobs for the alerting functions.
  - Read the alert router and store logs.
  - Watch trading by hand (the controller overview) until it's fixed.
---

## What it means

Alarms named `AlertingMeta-…`, delivered straight to incident.io and email so they work when the router doesn't:

| Alarm | Fires when |
|---|---|
| router / store / ingest errors | the alerting functions failing |
| tick not running | the 1-minute tick hasn't run for 5 minutes (rule disabled or deleted, or EventBridge not invoking it) |
| DLQ | alert events failed delivery repeatedly |
| undelivered | an alert has owed a sink for over 10 minutes (Slack or incident.io refusing it) |

## Impact

Alerts may be late or missing. Nothing pages for a dead session until it's fixed.

## Diagnose

The router's and store's CloudWatch logs; the database ([registry-down](../procedures/registry-down.md)); the Slack and incident.io secrets (expired token, revoked alert source).

## Resolve

Fix the failing part; owed notifications are retried by the tick once it runs again.

## Escalate

Escalate if alerting stays down while sessions are live.

## Related

[registry-down](../procedures/registry-down.md)
