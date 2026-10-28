---
type: MARKET_DATA_BAD
summary: A session's book for a listing has been flagged bad data for over a minute, so its OMS refuses new orders there.
first_steps:
  - Check the session's gateway alerts (RECONNECTING, BOOK_RESYNCS) and the venue's status.
  - Open the session's logs for ORDER_REJECTED_MARKET_DATA_BAD and the gateway's resync lines.
  - Check whether the session holds a position or resting orders on the listing.
---

## What it means

The listing's market-data gateway flagged its book bad (a sequence gap, a resync, a lost or replaced connection, a
book overflow) and no good book has arrived since. Until one does, the OMS refuses new orders and modifies on the
listing with `MARKET_DATA_BAD`; resting orders stay and cancels still go out. Marks hold the last good book.

## Impact

The strategy can't open, add to or reprice anything on the listing, nor flatten it (a wind-down's closing orders are
refused too). Resting quotes stay at prices set from the last good book and can still fill.

## Diagnose

Logs: `ORDER_REJECTED_MARKET_DATA_BAD` (once per bad spell), and the gateway's resync and socket lines for the
listing. A resync normally completes in seconds; a book that stays bad usually means the venue sent no snapshot (the
gateway marks the market EMPTY and rechecks every 15 minutes) or the market was quarantined after repeated resyncs.

## Resolve

Usually clears by itself when the venue sends a fresh book. If resting orders are at risk, cancel them (the strategy's
pull still goes out, or use a listing kill switch). A market the venue has closed won't recover: stop the session.

## Escalate

Escalate when a position is held on it for long (see MARKET_DATA_BAD_HELD).

## Related

[inspect-session](../procedures/inspect-session.md), [stop-or-kill](../procedures/stop-or-kill.md)
