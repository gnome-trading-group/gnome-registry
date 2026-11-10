---
type: GATEWAY_VENUE_RATE_LIMITED
summary: A venue answered an order gateway's requests on an account with 429s in the last minute.
first_steps:
  - Read the labels for the account and the count.
  - Check which sessions on the account were busiest (controller, their order rates).
---

## What it means

The gateway paces each account's requests to the venue's published limits. A 429 means the venue counted more than that: its limits changed, another client uses the same key, or the gateway's limits are wrong.

## Impact

The refused requests are retried or rejected back to sessions; orders and cancels on the account are delayed while it lasts.

## Diagnose

- The gateway's minute summary for the account: sent, held, refused, and 429s.
- Whether anything else uses the account's key (research, manual trading).
- The venue's current published limits against `VenueRateLimits` in gnome-gateways.

## Resolve

- Stop whatever else uses the key, or lower the sessions' rates (`rate_weight`, `order.gateway.max.new.per.second`).
- Update the venue's limits in gnome-gateways if they changed.

## Escalate

No.

## Related

[GATEWAY_DEGRADED](GATEWAY_DEGRADED.md)
