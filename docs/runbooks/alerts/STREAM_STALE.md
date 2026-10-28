---
type: STREAM_STALE
summary: Collected streams have been stale or quarantined for 5 minutes, in one source and region.
first_steps:
  - The alert key is `STREAM_STALE:<source>:<region>`; its title counts the streams.
  - On Market Data → Shards, find the streams in STALE or QUARANTINED and the connections they're on.
  - Check whether the venue itself is degraded before changing anything.
---

## What it means

The shard is subscribed but no longer trusts the streams' books: STALE (silent much longer than the market usually is, or a probe found the book wrong) or QUARANTINED (resynced 3 times in 10 minutes). Minutes while stale are uncovered.

## Impact

Those minutes count as gaps. Live trading is unaffected (sessions run their own feeds).

## Diagnose

- The shard's status: resyncs per stream, the connection's state and reconnects.
- The shard's logs for resync reasons (sequence gaps, best-price mismatches, probe mismatches).
- Many streams on one connection: that connection or the venue. A few scattered streams: those markets (illiquid or closing).

## Resolve

- Venue-wide: wait it out.
- One connection: it reconnects by itself; a shard restart (stop its task) moves everything to fresh connections.
- A market that resyncs forever: retire it from the rule.
- A quarantined market is retried after 5, then 15, then 60 minutes; the alert resolves once the streams are covered.

## Escalate

No.

## Related

[STREAM_NOT_LIVE](STREAM_NOT_LIVE.md), [BOOK_RESYNCS](BOOK_RESYNCS.md)
