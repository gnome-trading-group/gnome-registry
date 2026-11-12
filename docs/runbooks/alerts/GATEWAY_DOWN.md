---
type: GATEWAY_DOWN
summary: An order gateway that was READY is gone (no running task, or no endpoint item) while sessions were linked or orders working.
first_steps:
  - Read the labels: `workingOrders` above 0 means orders may be resting at the venue with nothing watching them (this pages). `cleanStop` true means its planned stop finished (every order cancelled, every session told) and only the gateway is missing (a warning).
  - Check the ECS service `order-gateway-<key with : as ->` in `order-gateways` for the stopped task's reason.
  - If it isn't back within a few minutes and orders were working, run the emergency cancel for each account (`docs/runbooks/procedures/stop-or-kill.md`).
---

## What it means

The gateway reconciler saw this gateway READY with `linked_sessions` or `working_orders` above zero, and now its endpoint item has expired (no write for 60 s) or ECS runs no task for it, without the reconciler having asked it to stop. The process crashed, was killed (out of memory, host lost) or hangs.

With `cleanStop` true, it was stopped from outside without the reconciler asking (its host shut down or was terminated, or the task was stopped by hand), and its planned stop ran to the end: it cancelled every order, told every session, and wrote that it held none before it went.

## Impact

Its sessions can't send or cancel orders. Orders it held stay at the venue until it restarts: ECS starts a new task, which takes its open orders back from the ownership log on the host volume and cancels those of sessions that don't return in time. If it comes back on another host, that state is gone: sessions that return have their listed orders looked up and cancelled, and its startup sweep cancels any the venue still holds from before it started about 30 s after it starts (`GATEWAY_UNATTRIBUTED_ORDERS`). On Polymarket Intl the venue itself cancels the account's orders about 10 s after the gateway's heartbeats stop.

After a clean stop nothing rests: sessions only wait for the replacement.

## Diagnose

- The last lines of the gateway log `/gnome/order-gateway/<region>`: `GATEWAY_FATAL` reasons, a watchdog stall, an exception.
- The ECS stopped-task reason (exit code, OutOfMemory, host terminated).
- Whether a replacement task is starting (service events), and on which host.

## Resolve

- A replacement usually comes up on its own; the alert resolves when it is READY. Measured in prod: a hung JVM killed
  by `gateway-start.sh`'s supervisor (no `/health` answer for 15 s) is READY again on the same host in about a minute;
  a lost host is replaced and READY in about 3 minutes.
- If it doesn't, or the host was lost, cancel the accounts' orders with `EmergencyCancel` (Treasury in the controller, or `aws lambda invoke`; see `stop-or-kill.md`), then stop the affected sessions.

## Escalate

Yes, for a live gateway when orders were working and it isn't back within 5 minutes.

**A paper gateway.**

A paper gateway (`paper:<exchange>:main`, alert mode `paper`, never pages) simulates its venue: nothing rests at a real
venue, so there is nothing to cancel and EmergencyCancel doesn't apply. Its paper sessions' new orders are refused
`GATEWAY_UNAVAILABLE` until it is back; the replacement knows none of their orders and reports each CANCELED when the
session says hello again. It runs on the paper hosts (`order-gateway-paper-hosts`, `c7a.medium`). Act only if it
keeps failing: read its log for the cause.

## Related

[GATEWAY_FATAL](GATEWAY_FATAL.md), [GATEWAY_START_STUCK](GATEWAY_START_STUCK.md), [EMERGENCY_CANCEL](EMERGENCY_CANCEL.md)
