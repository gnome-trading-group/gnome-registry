---
type: GATEWAY_HELD_CHECK_FAILED
summary: An order gateway hasn't been able to check its held orders against the venue for three checks in a row.
first_steps:
  - Read the gateway log for "held-order check failed" and the error it gives.
  - Check the venue's status page.
---

## What it means

The check reads the venue's open orders, lookups and trades every 5 minutes. Three checks in a row (about 15 minutes) failed. It keeps trying, and it resolves on the next check that works. Trading is unaffected: the check is apart from order entry and the account socket.

## Impact

Orders the venue ends without telling the gateway stay held until a check works. A held order can keep the gateway from idle-stopping, and its cancels get "not found".

## Diagnose

The error in the log line: auth, rate limit (429), timeout or venue outage.

## Resolve

A venue outage resolves itself. A persistent auth error means the account's trading key (`gnome/accounts/<label>/trading`) has a problem the gateway's next connect will hit too.

## Escalate

If it lasts past an hour.

## Related

[GATEWAY_ORDER_GONE_AT_VENUE](GATEWAY_ORDER_GONE_AT_VENUE.md), [GATEWAY_SWEEP_FAILED](GATEWAY_SWEEP_FAILED.md)
