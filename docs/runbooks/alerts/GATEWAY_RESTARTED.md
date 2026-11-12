---
type: GATEWAY_RESTARTED
summary: An order gateway's task was replaced without the reconciler asking, while sessions had orders working through it.
first_steps:
  - Read the alert's stop reason for the old task.
  - Check that sessions linked to the new gateway (no ORDER_GATEWAY_UNLINKED) and its startup sweep logged.
---

## What it means

The gateway reconciler saw a new task running the gateway, the old one having stopped on its own (a crash, a failed health check, the host going), while the gateway's last endpoint showed orders working. A planned stop or a release doesn't raise it.

## Impact

Orders the old gateway held are taken back from its ownership log when the new task runs on the same host. On another host that log is gone: sessions' hellos list what they hold, and the gateway's startup sweep cancels what nobody claims after its window (30 s plus the sessions' cancel-on-disconnect timeouts).

## Diagnose

- The stop reason in the alert, and the old task's last log lines in `/gnome/order-gateway/<region>` (`FATAL`, watchdog stacks).
- The new task's log: `took back N of M open orders`, `swept its open orders, N unrecorded`, and the sessions linking.

## Resolve

Find why the task stopped (the stop reason, the old log's tail) and fix it. Check [GATEWAY_UNATTRIBUTED_ORDERS](GATEWAY_UNATTRIBUTED_ORDERS.md) for orders the sweep cancelled.

**A paper gateway.**

The simulated venue doesn't survive the process: the new task knows none of the paper sessions' orders and reports each
CANCELED, nothing filled, when the session says hello again. Nothing real rests, and there is no sweep. Look into it
only if it repeats.

## Escalate

If it repeats, or sessions don't link to the new gateway.

## Related

[ORDER_GATEWAY_UNLINKED](ORDER_GATEWAY_UNLINKED.md), [GATEWAY_FATAL](GATEWAY_FATAL.md), [GATEWAY_DOWN](GATEWAY_DOWN.md)
