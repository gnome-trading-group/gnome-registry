---
type: GATEWAY_HELD_CHECK_CAPPED
summary: An order gateway found more held orders missing at the venue than it ends in one check, and left the rest for the next.
first_steps:
  - Check the account's open orders on the venue (EmergencyCancel dry run) against what the gateway holds.
  - Read the gateway log's "held-order check" lines.
---

## What it means

Each check cancels, and so ends, at most 5 orders the venue no longer lists but can't prove finished. More than that were due. The rest wait for the next check, 5 minutes later. It resolves once a check isn't capped.

## Impact

Many orders vanishing at once has two causes:
- A market with many of our quotes closed: harmless, and the orders drain 5 per check.
- The venue misreading working orders (an outage or API change): each one the gateway ends is then left resting with no owner until the next check cancels it as unattributed.

## Diagnose

- Whether the venue still lists the orders (EmergencyCancel with `"dryRun": true`) and the venue's status page.
- Whether the alerted orders share a market.

## Resolve

- A closed market: nothing; it drains.
- A venue problem: set `gateway.held.check.act=false` and restart the gateway, and cancel anything resting unowned.

## Escalate

If the venue still lists orders the gateway ended.

## Related

[GATEWAY_ORDER_GONE_AT_VENUE](GATEWAY_ORDER_GONE_AT_VENUE.md), [EMERGENCY_CANCEL](EMERGENCY_CANCEL.md)
