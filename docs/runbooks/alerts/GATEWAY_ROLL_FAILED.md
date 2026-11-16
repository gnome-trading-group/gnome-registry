---
type: GATEWAY_ROLL_FAILED
summary: A roll an operator asked for didn't bring the order gateway up on its target release; it was rolled back (ERROR) or the rollback failed too (CRITICAL).
first_steps:
  - Find the gateway in the alert key (`GATEWAY_ROLL_FAILED:<live|paper>:<exchange>:<instance>`) and the from/to releases in the labels.
  - Read its roll item `order-gateway#<key>#roll` in `service-endpoints` (us-east-1), or the gateway's page in the controller, for the phase it reached and why.
  - CRITICAL: check whether orders still rest at the venue (`working orders` on the gateway page, or `procedures/check-venue-orders.md`) and whether sessions still quote.
---

## What it means

An operator pressed Roll. The gateway reconciler (gnome-orchestrator, Lambda `GatewayReconciler`) stopped the gateway
without cancelling (a handover: its orders stay at the venue, recorded in the ownership log on its host) and started it
again on the same host on the target release. It didn't become READY on that release within 5 minutes, or its task
stopped 3 times, so the reconciler rolled it back to the release it was on, the same way, once.

- `rolledBack=true` (ERROR): the rollback is READY on the old release. The orders were taken back from the log; the
  sessions re-linked. The target release doesn't start on this gateway.
- otherwise (CRITICAL): the rollback didn't come up either. Orders may rest at the venue with no gateway in front of
  them; the reconciler stops trying.

## Impact

During the roll and the rollback, sessions' new orders on this venue were refused `GATEWAY_UNAVAILABLE` and cancels
waited. Resting orders could fill unmanaged; those fills reach the OMS and ledger once a gateway is back.

CRITICAL: no gateway is up. Resting orders are unmanaged until one is, and a session that dies meanwhile leaves its
orders behind.

## Diagnose

- The roll item: `phase` (`rolled_back` or `failed`), `reason`, `from_version`, `to_version`, `instance_id` (the host
  it was pinned to), `from_task_definition`.
- The gateway log `/gnome/order-gateway/<region>`, stream `gateway/gateway/<task>`: `gateway-start.sh` (jar download for
  the target release, Elastic IP), then the Java process. A release that doesn't exist fails the download at once.
- ECS service `order-gateway-<key with : as ->` in cluster `order-gateways`: stopped tasks' reasons. A placement
  failure names the instance constraint: the pinned host is gone or full.
- The reconciler log `/aws/lambda/GatewayReconciler`.

## Resolve

- ERROR: nothing is at risk now. Find why the target doesn't start before rolling again. To stay on the old release
  for good, pin it (gateway page, release pin), so the next start doesn't pick up the target.
- CRITICAL, orders resting and no gateway:
  - Use emergency cancel for the venue account (gateway page, or `procedures/stop-or-kill.md`) if the orders must not
    stay unmanaged; it doesn't go through the gateway.
  - Then get a gateway up: pin a release known to start and let sessions ask for it (or press Roll again once the roll
    item says `failed`). A start on the same host takes the remaining orders back from the log; on another host the
    startup sweep and the sessions' hellos cancel them.
- To roll back by hand at any time: pin the `from_version` and press Roll.

## Escalate

CRITICAL with orders resting and emergency cancel not working: page the on-call owner of the venue account.

## Related

[GATEWAY_START_STUCK](GATEWAY_START_STUCK.md), [GATEWAY_DOWN](GATEWAY_DOWN.md), [GATEWAY_RESTARTED](GATEWAY_RESTARTED.md), [GatewayReconciler](../cloudwatch/GatewayReconciler.md)
