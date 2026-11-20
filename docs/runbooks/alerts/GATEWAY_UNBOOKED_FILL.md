---
type: GATEWAY_UNBOOKED_FILL
summary: An order gateway ended an order the venue had filled beyond what the session was told, so those fills are missing from the ledger.
first_steps:
  - Read the alert's venueFilled and reported labels, and the order's session and counter.
  - Compare the venue's trades for the order with ledger.fill.
---

## What it means

The gateway's check found this order finished at the venue with more filled (`venueFilled`, size ×1e6) than the gateway had reported (`reported`). It waited a check (about 5 minutes) for those fills to arrive on the socket. They didn't, so it ended the order with the fills it had reported. The difference reached no session.

## Impact

The session's position and the ledger are short by `venueFilled - reported` on that listing until the fills are booked.

## Diagnose

- The order's trades at the venue (Polymarket International `/data/trades` naming its hash), against `ledger.fill` for the session's order.
- The gateway log for socket reconnects or catch-up failures around the fill times.

## Resolve

Book the missing fills with a ledger adjustment, or let the venue poller's reconciliation (Treasury) flag them.

## Escalate

If the missing size is material, or it happens more than once in a day.

## Related

[GATEWAY_ORDER_GONE_AT_VENUE](GATEWAY_ORDER_GONE_AT_VENUE.md), [RECON_MISMATCH](RECON_MISMATCH.md)
