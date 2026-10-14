---
type: BOOK_RESYNCS
summary: A gateway keeps finding its order book inconsistent and resyncing.
first_steps:
  - Check the session's logs for MARKET_DATA_GAP.
  - Check the venue's status.
  - Stop the session if it keeps happening.
---

## What it means

The gateway resynced its book three or more times in five minutes (a sequence gap, a bad nonce or a crossed book). Each resync forces a reconnect.

## Impact

The strategy trades on a book that may be wrong between resyncs, and ten gateway errors in a minute exit the session.

## Diagnose

`MARKET_DATA_GAP` lines name the cause (SEQUENCE, NONCE, BEST_PRICE) and the listing.

## Resolve

A venue-side problem usually passes; a persistent one on one listing may need that listing halted.

## Escalate

Escalate if it's on a live session and continues.

## Related

[inspect-session](../procedures/inspect-session.md)
