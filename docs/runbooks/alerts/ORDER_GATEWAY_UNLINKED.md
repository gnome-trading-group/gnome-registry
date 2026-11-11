---
type: ORDER_GATEWAY_UNLINKED
summary: A live session has been unlinked from a venue's order gateway for over a minute while it has orders working there.
first_steps:
  - Check the gateway's ECS service (cluster order-gateways) and its log group /gnome/order-gateway/<region>.
  - If the session can't link again soon, cancel the account's orders with EmergencyCancel, then stop the session.
---

## What it means

The session's heartbeat shows its link to the gateway (`live:<exchange>:main`) down, with orders it placed on that venue still working. Usually the gateway crashed or was replaced and the session hasn't linked to the new one yet: it looks the gateway's address up again after 5 s without an answer, and links once the new gateway has written its endpoint. A planned stop cancels the session's orders before the gateway goes, so it doesn't raise this.

## Impact

Those orders rest at the venue and can fill, but the session can't cancel or amend them, and it hears of nothing that happens to them until it links again. New orders on the venue are refused `GATEWAY_UNAVAILABLE`.

## Diagnose

- The session's log: `Gateway live:<exchange>:main: connecting to …` lines, and `nothing answered at its address … looking it up again`.
- The gateway's log: whether a new process started (`gateway-start:` lines), went READY, and linked the session (`linked on image`).
- `service-endpoints` item `order-gateway#<key>`: the address sessions are given.
- The gateway reconciler's alerts for the same gateway: [GATEWAY_RESTARTED](GATEWAY_RESTARTED.md), [GATEWAY_DOWN](GATEWAY_DOWN.md), [GATEWAY_START_STUCK](GATEWAY_START_STUCK.md).

## Resolve

- A gateway coming back: wait for the link; the session's hello lists its orders, and the gateway looks each up at the venue and reports it as it stands. This resolves on the next heartbeat once linked.
- A gateway that won't come back: run EmergencyCancel for the account (runbook `procedures/stop-or-kill.md`), then stop the session.

## Escalate

If it lasts past five minutes, or the orders could fill into a position nobody is managing.

## Related

[GATEWAY_RESTARTED](GATEWAY_RESTARTED.md), [GATEWAY_DOWN](GATEWAY_DOWN.md), [EMERGENCY_CANCEL](EMERGENCY_CANCEL.md)
