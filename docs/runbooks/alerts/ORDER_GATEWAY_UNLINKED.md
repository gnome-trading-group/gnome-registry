---
type: ORDER_GATEWAY_UNLINKED
summary: A session has been unlinked from a venue's order gateway for over a minute while it has orders working there.
first_steps:
  - Check the gateway's ECS service (cluster order-gateways) and its log group /gnome/order-gateway/<region>.
  - If the session can't link again soon, cancel the account's orders with EmergencyCancel, then stop the session.
---

## What it means

The session's heartbeat shows its link to the gateway (`live:<exchange>:main`, or `paper:<exchange>:main` for a paper
session, which stays below paging) down, with orders it placed on that venue still working. Usually the gateway crashed or was replaced and the session hasn't linked to the new one yet: it looks the gateway's address up again after 5 s without an answer, and links once the new gateway has written its endpoint. A planned stop cancels the session's orders before the gateway goes, so it doesn't raise this.

## Impact

New orders on the venue are refused `GATEWAY_UNAVAILABLE`. What happens to the working orders depends on which side is
gone:

- **The gateway is up and only the session is cut off** (its host, its network): the gateway cancels the session's
  orders once it has been silent for its cancel-on-disconnect timeout (`order.gateway.cod.timeout.ms`, 5 s by default).
  The prod partition drill saw exactly that, and the session linked again 0.2 s after the network healed. The session's
  `workingOrders` count is stale until it links and hears the cancels.
- **The gateway is down or hung**: the orders rest at the venue and can fill, and the session can't cancel or amend
  them, or hear of them, until it links again. Check the gateway alerts below.

A paper session's orders are simulated: nothing rests at a real venue either way.

## Diagnose

- The session's log: `Gateway live:<exchange>:main: connecting to …` lines, and `nothing answered at its address … looking it up again`.
- The gateway's log: whether a new process started (`gateway-start:` lines), went READY, and linked the session (`linked on image`).
- `service-endpoints` item `order-gateway#<key>`: the address sessions are given.
- The gateway reconciler's alerts for the same gateway: [GATEWAY_RESTARTED](GATEWAY_RESTARTED.md), [GATEWAY_DOWN](GATEWAY_DOWN.md), [GATEWAY_START_STUCK](GATEWAY_START_STUCK.md).

## Resolve

- A gateway coming back: wait for the link; the session's hello lists its orders, and the gateway looks each up at the venue and reports it as it stands. This resolves on the next heartbeat once linked.
- A gateway that won't come back: run EmergencyCancel for the account (runbook `procedures/stop-or-kill.md`), then stop the session. Not for a paper gateway: stop the session if it matters.

## Escalate

If it lasts past five minutes, or the orders could fill into a position nobody is managing.

## Related

[GATEWAY_RESTARTED](GATEWAY_RESTARTED.md), [GATEWAY_DOWN](GATEWAY_DOWN.md), [EMERGENCY_CANCEL](EMERGENCY_CANCEL.md)
