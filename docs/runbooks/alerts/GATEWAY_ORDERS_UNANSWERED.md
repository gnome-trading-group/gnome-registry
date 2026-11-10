---
type: GATEWAY_ORDERS_UNANSWERED
summary: The venue never answered some orders or cancels an order gateway sent on an account in the last minute.
first_steps:
  - Read the labels for the account and how many orders and cancels went unanswered.
  - Compare the account's open orders at the venue (`docs/runbooks/procedures/check-venue-orders.md`) with the sessions' open orders.
---

## What it means

The gateway's minute summary for the account counted requests (new orders, amends or cancels) that got no response: the connection failed or timed out after sending. Each may or may not have reached the venue.

## Impact

An unanswered new order may be resting at the venue though the session thinks it failed, or the other way round. The account's reader (the venue's order feed) usually settles it within seconds; if it can't, the order is unknown to the session.

## Diagnose

- The gateway log around that minute: connection errors, timeouts, the venue's latency.
- Whether the venue was degraded then.
- The venue's open orders against the ledger's (`ledger.order` with status OPEN for the account).

## Resolve

- Most settle themselves through the reader; the alert resolves after a minute without any.
- An order resting that no session holds: cancel it at the venue, or run `EmergencyCancel` for the account.

## Escalate

If it repeats for 10 minutes, or orders are found resting unknown.

## Related

[GATEWAY_DEGRADED](GATEWAY_DEGRADED.md), [GATEWAY_UNATTRIBUTED_ORDERS](GATEWAY_UNATTRIBUTED_ORDERS.md)
