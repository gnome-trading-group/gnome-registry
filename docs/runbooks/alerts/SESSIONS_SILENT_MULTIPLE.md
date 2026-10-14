---
type: SESSIONS_SILENT_MULTIPLE
summary: Several sessions went silent at once; the registry or the heartbeat path is the likely cause.
first_steps:
  - Check /system → Databases and Services for the registry.
  - Check the registry API's 5xx rate and RDS status in AWS.
  - If live sessions are affected, check the venues.
---

## What it means

Three or more sessions went silent in the same minute. Their individual alerts go to Slack only; this one pages.

## Impact

Sessions protect themselves when they can't reach the registry: 30 seconds without a risk refresh and they refuse new orders. Resting orders stay.

## Diagnose

See [registry-down](../procedures/registry-down.md). If the registry is healthy, check the sessions' instances (an AMI or region-wide problem).

## Resolve

Restore the registry; the sessions' heartbeats resume on their own and the alerts resolve.

## Escalate

Escalate if the registry is down for more than a few minutes with live sessions.

## Related

[registry-down](../procedures/registry-down.md), [check-venue-orders](../procedures/check-venue-orders.md)
