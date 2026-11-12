---
type: GATEWAY_START_STUCK
summary: An order gateway that sessions want hasn't become READY 6 minutes after the reconciler started it.
first_steps:
  - Find the gateway in the alert key (`GATEWAY_START_STUCK:<live|paper>:<exchange>:<instance>`) and its region in the labels.
  - Check the ECS service `order-gateway-<key with : as ->` in cluster `order-gateways` for stopped tasks and their reasons (also in the alert title).
  - Read the gateway log `/gnome/order-gateway/<region>`, stream `gateway/gateway/<task>`.
---

## What it means

A session asked for this gateway (the launcher, or the session itself every 10 s while it waits), the gateway reconciler (gnome-orchestrator, Lambda `GatewayReconciler`) set its ECS service to one task, and 6 minutes later its endpoint item in `service-endpoints` (`order-gateway#<key>`) still doesn't say READY. A cold start (host, image, jar download, venue connections) took about 2.5 minutes in prod on a fresh host; the
first start after a release waits about 1.5 minutes more while the reconciler moves the service onto the new revision.

## Impact

Live sessions on this venue can't trade: a NEW is rejected `GATEWAY_UNAVAILABLE`, and a starting session gives up after `order.gateway.start.timeout.seconds` (10 min) and fails. Nothing rests at the venue through this gateway.

## Diagnose

- ECS service events and stopped tasks' `stoppedReason`: no capacity (`order-gateway-hosts` can't place a `c7a.large`), image pull, out of memory, the container exiting.
- The gateway log: `gateway-start.sh` lines first (jar download, Elastic IP attach), then the Java process. A jar that can't start (`java -jar` needs the release's manifest module access) dies at once.
- Stuck at STARTING: an account that never connects (venue down, credentials `gnome/accounts/<label>/trading` wrong or missing in that region) or the registry unreachable (`venue-accounts/gateway`).
- The reconciler log `/aws/lambda/GatewayReconciler` for what it registered (task definition revision, Elastic IP).

## Resolve

- Fix the cause; ECS keeps replacing the task, and the alert resolves once the gateway is READY.
- A bad orchestrator release: the gateway runs `/gnome/orchestrator/latest-version`; point it at the last good version and the reconciler registers a new revision on its next tick.

**A paper gateway.**

Its paper sessions can't trade until it is READY; nothing real is at risk. It runs on `order-gateway-paper-hosts`
(`c7a.medium`) from the base task definition `order-gateway-paper`, has no venue account and no Elastic IP. What stops
one instead:

- The market-data lease API: its revision carries `MARKET_DATA_API_URL` and `MARKET_DATA_API_KEY_SECRET`; a key it
  can't read stops it reading its sessions' books.
- The exchange in its key missing from the security master (`No exchange <CODE> for paper:...`).

A paper gateway that is READY but can't build a session's simulation logs `can't simulate session <id>'s venue` and
refuses that session's new orders `GATEWAY_NOT_READY`: check the session's `config.simulation` (its `as_of` and
overrides).

## Escalate

Only if live sessions must trade now and the cause isn't clear within the hour.

## Related

[GATEWAY_DOWN](GATEWAY_DOWN.md), [GATEWAY_RECONCILE_FAILED](GATEWAY_RECONCILE_FAILED.md), [GatewayReconciler](../cloudwatch/GatewayReconciler.md)
