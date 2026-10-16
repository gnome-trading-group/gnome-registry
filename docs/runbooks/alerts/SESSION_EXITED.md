---
type: SESSION_EXITED
summary: A strategy ended its own session; a WARNING means it couldn't close everything it held.
first_steps:
  - INFO needs nothing; it is a record.
  - On a WARNING, the body lists each listing still held. Check the venue and close or keep them.
---

## What it means

The strategy asked to stop (for example a pregame strategy once its match went live). Its session cancelled its
orders, closed its positions if the strategy asked for that, and shut down. The session ends STOPPED, with the
strategy's reason in "stop reason".

INFO: everything the strategy asked for was done. WARNING: it asked to close its positions, and some were still open
when its time ran out, usually because the book was too thin to sell into.

## Impact

INFO: none. WARNING: the listings in the body are still held with nothing managing them. On a binary contract they
settle on their own at resolution; until then they are open exposure.

## Diagnose

The body lists each listing still held and its quantity. The session's Fills & Orders tab shows the closing orders
it sent and how much of each filled.

## Resolve

Decide per listing whether to keep the position to settlement or close it by hand on the venue
([check the venue](../procedures/check-venue-orders.md)). A later session of the same strategy picks the position up
too, if one runs on that listing.

## Escalate

Only if the position is large enough that holding it to settlement is not acceptable and the venue can't be reached.

## Related

[SESSION_STOPPED_AUTO](SESSION_STOPPED_AUTO.md), [STOP_STUCK](STOP_STUCK.md)
