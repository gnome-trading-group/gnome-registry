---
type: GATEWAY_FATAL
summary: An order gateway is exiting on an error: a lane, connection, ingress or egress failure, or a watchdog stall.
first_steps:
  - Read the alert for the reason, and the gateway log `/gnome/order-gateway/<region>` before it.
  - Watch for the replacement task to come up READY (ECS service `order-gateway-<key with : as ->`, cluster `order-gateways`).
  - If it doesn't, treat it as GATEWAY_DOWN.
---

## What it means

The gateway hit an error it can't carry on from, and is exiting so ECS replaces it. It reports this as it goes, before its threads stop.

## Impact

Its sessions lose their link until the replacement is READY. Open orders stay at the venue; the replacement takes them back from the ownership log and cancels those of sessions that don't return.

## Diagnose

- The reason in the alert: which thread failed, and its exception.
- A watchdog stall names the stuck thread (ingress, egress, a lane or a reader); repeated stalls point at a venue call blocking or the host starved.

## Resolve

- Usually nothing: the replacement recovers. A crash that repeats on every start needs a fix, or a rollback of the orchestrator release.

## Escalate

If it repeats, or GATEWAY_DOWN follows.

## Related

[GATEWAY_DOWN](GATEWAY_DOWN.md), [GATEWAY_START_STUCK](GATEWAY_START_STUCK.md)
