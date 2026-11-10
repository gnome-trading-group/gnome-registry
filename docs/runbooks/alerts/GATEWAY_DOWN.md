---
type: GATEWAY_DOWN
summary: A live order gateway that was READY is gone (no running task, or no endpoint item) while sessions were linked or orders working.
first_steps:
  - Read the labels: `workingOrders` above 0 means orders may be resting at the venue with nothing watching them (this pages).
  - Check the ECS service `order-gateway-<key with : as ->` in `order-gateways` for the stopped task's reason.
  - If it isn't back within a few minutes and orders were working, run the emergency cancel for each account (`docs/runbooks/procedures/stop-or-kill.md`).
---

## What it means

The gateway reconciler saw this gateway READY with `linked_sessions` or `working_orders` above zero, and now its endpoint item has expired (no write for 60 s) or ECS runs no task for it, without the reconciler having asked it to stop. The process crashed, was killed (out of memory, host lost) or hangs.

## Impact

Its sessions can't send or cancel orders. Orders it held stay at the venue until it restarts: ECS starts a new task, which takes its open orders back from the ownership log on the host volume and cancels those of sessions that don't return in time. If the host itself is gone, that state went with it, and nothing cancels them.

## Diagnose

- The last lines of the gateway log `/gnome/order-gateway/<region>`: `GATEWAY_FATAL` reasons, a watchdog stall, an exception.
- The ECS stopped-task reason (exit code, OutOfMemory, host terminated).
- Whether a replacement task is starting (service events), and on which host.

## Resolve

- A replacement usually comes up within minutes; the alert resolves when it is READY.
- If it doesn't, or the host was lost, cancel the accounts' orders with `EmergencyCancel` (Treasury in the controller, or `aws lambda invoke`; see `stop-or-kill.md`), then stop the affected sessions.

## Escalate

Yes, when orders were working and it isn't back within 5 minutes.

## Related

[GATEWAY_FATAL](GATEWAY_FATAL.md), [GATEWAY_START_STUCK](GATEWAY_START_STUCK.md), [EMERGENCY_CANCEL](EMERGENCY_CANCEL.md)
