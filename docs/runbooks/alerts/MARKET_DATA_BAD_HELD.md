---
type: MARKET_DATA_BAD_HELD
summary: A listing's book has been bad for over five minutes while the session holds a position there; nothing can trade out of it.
first_steps:
  - Check the position and resting orders on the listing in the controller.
  - Check the venue's status and whether the market is still trading.
  - Decide whether to flatten by hand on the venue or wait for the book.
---

## What it means

As MARKET_DATA_BAD, for over five minutes, and the session's strategy holds a position on the listing. The OMS refuses
every new order there, including a wind-down's closing orders, until a good book arrives.

## Impact

The position can't be reduced through the session. Its mark is the last good book's, so PnL and risk limits don't see
moves since.

## Diagnose

Same as MARKET_DATA_BAD: the session's `ORDER_REJECTED_MARKET_DATA_BAD` line and the gateway's resync lines. Check the
venue's own UI for the market's current price.

## Resolve

If the book won't recover soon and the exposure matters, close the position on the venue by hand, then adjust the
ledger (`ledger adjustments` in the controller). Otherwise wait; orders work again as soon as a good book arrives.

## Escalate

Escalate at once on a large position, or a market near resolution.

## Related

[inspect-session](../procedures/inspect-session.md), [stop-or-kill](../procedures/stop-or-kill.md),
[check-venue-orders](../procedures/check-venue-orders.md)
