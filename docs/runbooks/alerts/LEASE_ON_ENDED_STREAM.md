---
type: LEASE_ON_ENDED_STREAM
summary: A session still leases streams an hour after their listings ended, so it is probably stuck instead of exiting with its market.
first_steps:
  - The `session_id` label names the session; the `streams` label lists the ended streams.
  - Check the session's status and recent logs for why it hasn't exited.
  - Stop the session if it has nothing left to trade.
---

## What it means

The session's lease includes streams whose listings went inactive (the market closed or resolved) at least an hour ago, and the session is still running. The reconciler retired those streams when their listings ended, so no shard collects them. A strategy whose markets have all closed should exit on its own; one still running an hour later is usually stuck or waiting on something that won't happen.

The hour counts from when the market-data reconciler first saw the listing inactive (the `ended_minutes` label), not from the venue's close.

## Impact

Little: no shard collects the ended streams, so they cost nothing. The session keeps its host, and any other listings it trades are unaffected. A live session holding open positions on an ended market is waiting on settlement, which is expected.

## Diagnose

- The session in the controller (Strategies → the session): its status, listings and last heartbeat.
- Its logs: is it still trading other listings, waiting on settlement, or idle?
- The listing (`GET /streams?streamIds=<id>` gives the listing; `active` false confirms it ended).

## Resolve

- Idle with nothing left to trade: stop the session.
- Still trading other listings: nothing to do; the alert clears when the session ends.
- If a strategy keeps doing this, make it exit when its markets close.

## Escalate

No, unless it is a live session with open orders on the ended market.

## Related

[LEASED_STREAM_UNPLACED](LEASED_STREAM_UNPLACED.md)
