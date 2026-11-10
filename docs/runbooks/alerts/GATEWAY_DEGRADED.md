---
type: GATEWAY_DEGRADED
summary: A live order gateway has been DEGRADED for 2 minutes: an account's lane or venue connection isn't healthy.
first_steps:
  - Read the gateway log `/gnome/order-gateway/<region>` for the account that went down (connection, reader or lane lines).
  - Check the venue's status page.
  - Check its sessions on the controller for orders rejected `GATEWAY_DEGRADED` or held.
---

## What it means

The gateway's state in its endpoint item has been DEGRADED on two reconciler ticks in a row. The gateway is up and linked to its sessions, but at least one account isn't READY: its order connection, its reader (the venue's order feed) or its lane.

## Impact

New orders on the affected account are refused or wait; cancels wait for the account to recover. Orders already resting stay at the venue, and are watched again only once the reader recovers.

## Diagnose

- The gateway log for that account: connect failures (logged once a minute), reader reconnects, venue 429s (`VENUE_RATE_LIMITED`), the minute summary's unanswered orders.
- The venue: an outage, maintenance, or credentials revoked.

## Resolve

- A venue outage: wait; the gateway reconnects on its own. Consider a kill switch on the exchange if sessions keep trying.
- Credentials: fix the account's key in Secrets Manager; the gateway reads it when it reconnects.
- If it stays DEGRADED with the venue healthy, stop the gateway's task; ECS replaces it while sessions want it.

## Escalate

If orders are resting and the account stays down for more than 15 minutes.

## Related

[GATEWAY_VENUE_RATE_LIMITED](GATEWAY_VENUE_RATE_LIMITED.md), [GATEWAY_ORDERS_UNANSWERED](GATEWAY_ORDERS_UNANSWERED.md)
