---
type: GATEWAY_ORDER_GONE_AT_VENUE
summary: An order gateway ended an order it held because the venue no longer had it, and the venue never said the order had ended.
first_steps:
  - Read the alert for the order (session-counter), its reason and the venue's fills against what was reported.
  - Check the gateway log for "gone at the venue" around then.
---

## What it means

Every 5 minutes (`gateway.held.check.interval.seconds`) the gateway checks each account's held orders against the venue (Kalshi, Polymarket International, Polymarket US). This order was missing from the venue's open orders, and the venue had finished it. `reason` says how the gateway knew:
- `TERMINAL`: the venue's lookup reports it finished.
- `FILLED` (Polymarket International): the lookup no longer knows it, and its trades fill it to its size.
- `NOT_FOUND`: the lookup doesn't know it on two checks at least 4 minutes apart, and the venue then proved it gone. On Polymarket International that proof is a cancel refused as "can't be found" (the CLOB forgets finished orders). On Kalshi and Polymarket US it is a third lookup, since their lookups keep finished orders, so one they don't know was never placed.

The gateway ended it (reported CANCELED with the fills it had reported), so it no longer counts as working and stops being cancelled.

The order did end at the venue, but its end event never reached the gateway's account socket. Without this check the order would be held for good: the gateway would never idle-stop, and its cancels would be answered "not found" forever.

## Impact

Usually none: the order had ended at the venue anyway. If `GATEWAY_UNBOOKED_FILL` fired with it, the venue filled more than the session was told.

## Diagnose

- How many fired at once, and on which markets. One market closing or settling explains a group. Many at once across markets suggests the venue misread working orders (see `GATEWAY_HELD_CHECK_CAPPED`).
- The account's open orders on the venue (EmergencyCancel with `"dryRun": true`). If an ended order is still resting there, the next check cancels it within 10 minutes as unattributed.

## Resolve

Nothing for one order. For a burst on a live account: if any ended order still rests at the venue, cancel it, and set `gateway.held.check.act=false` until it's understood.

## Escalate

If ended orders are found still resting at the venue, or the alert fires on many working orders at once.

## Related

[GATEWAY_UNBOOKED_FILL](GATEWAY_UNBOOKED_FILL.md), [GATEWAY_HELD_CHECK_CAPPED](GATEWAY_HELD_CHECK_CAPPED.md), [GATEWAY_UNATTRIBUTED_ORDERS](GATEWAY_UNATTRIBUTED_ORDERS.md)
