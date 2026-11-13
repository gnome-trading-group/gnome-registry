---
type: SHARD_ERRORS
summary: A market-data shard logged 3 or more unexpected errors in the last hour; something on it is broken, not just a venue being a venue.
first_steps:
  - The title ends with the latest error; find it in the table below.
  - Read the shard's log around it (Market Data → Shards → the shard → Logs, or `/collection/shards-<region>`, filter `UNKNOWN_ERROR`).
  - If the line isn't in the table, it is new: work out whether it is a bug or something routine logged at the wrong level.
---

## What it means

Shards log what they handle by themselves at other levels: a venue closing a socket (`SOCKET_DISCONNECTED`, then a reconnect), a book that drifted and is resynced, a roll. What is left as `UNKNOWN_ERROR` is unexpected. Each shard counts those and reports the count in its status every 15 s; the reconciler (gnome-market-data) raises this alert at 3 or more in the last hour, keeps it open while any remain in the hour, and resolves it after an hour without one. The threshold comes from replaying a week of prod logs: every alert it would have raised there was a real bug.

## Impact

Depends on the error. Sessions read their market data from shards, so an error that drops or reconnects a connection shows in trading as bad market data on that connection's listings (`MARKET_DATA_BAD`); one about the shard's status or probe doesn't touch the data itself.

## Diagnose

The title carries the latest line; the `latest` label has it whole. Known lines:

| Line | Meaning | Action |
|---|---|---|
| `Error occurred in <CONN>: <exception>` | A feed connection's reader or supervisor threw; the connection reconnected, so its markets were bad for a moment. | The exception names the bug. An `IllegalStateException` or parse error is gnome-gateways' (the venue's protocol class); fix it there. |
| `Error occurred in POLYMARKET_US-<n>: IllegalStateException: A Polymarket US connection holds at most 100 markets` | A rolled connection's protocol didn't free a removed market's place. Fixed in gnome-gateways 4.4.1. | On 4.4.1 or later it is a new bug in `PolymarketUsProtocol`'s groups. |
| `Polymarket US error: slug already subscribed: <slug>` | A market is in two of the connection's subscriptions, most likely the same rolled-protocol bug (4.4.1). | If it continues on 4.4.1 or later, look at how `PolymarketUsProtocol` places a market that was removed and added again. |
| `<source>: <unreadable frame>` / `<CONN>: unreadable frame: ...` | The venue sent a frame the protocol can't read at all; the connection reconnected. | A venue format change: capture a raw frame (`raw/<source>/<shard>/<conn>/...` in the exchange-raw bucket) and fix the protocol. |
| `<source>: replacement for <conn> didn't sync; keeping it. Still waiting: <markets>` | A roll's new connection got no book for those markets; the old connection stays, and the roll is retried every 10 minutes. | Usually markets that closed at the venue: check them there. A market the venue no longer serves should end in the registry so its stream retires. Polymarket US closes connections after about an hour, so one that can't roll reconnects instead. |
| `<source>: rolled ... N markets short of some` (N > 0) | A roll left a hole in N markets' streams: the stand-in's 128 records ran out before the handover. | Rare and brief. If it repeats, the market is too busy for the replay log: raise `ConnectionGroup.STAND_IN_RECORDS` in gnome-gateways. |
| `<source>: couldn't open a replacement ...`, `... didn't let its markets go`, `... slow to take its markets over` | A roll's own machinery failed or stalled. | Read the lines around it; the old connection keeps its markets except for the last. |
| `Shard status failed: IndexOutOfBoundsException` | The status outgrew its buffer on a number (gnome-core before 1.23.0). | Roll the shard onto an orchestrator with gnome-core 1.23.0 or later. Any other `Shard status failed`: S3 (task role, network). |
| `Shard tick failed: ...` / `Failed to read the assignment: ...` | The shard can't apply its assignment: streams aren't started or stopped. | DynamoDB or the security master; the cause chain says which. |
| `Book probe failed: ...` | The REST book check threw; books go unverified. | The venue's REST API or the probe's parsing. |
| `<CONN> gave up before carrying any market` / `Giving up on <CONN>` | A connection couldn't connect at all. | Venue status and the shard's market-data credentials (`gnome/market-data/<source>/<label>`). |

## Resolve

- Fix the bug in the repo the line points to, release it, and roll the shards (`roll_to_version` in the `market-data` Service Config).
- A line that turns out to be routine (handled, nothing to do) must not stay an `UNKNOWN_ERROR`: lower its level where it is logged, so it stops counting. Never raise the threshold or mute this alert to quiet a routine line.
- The alert resolves an hour after the last error.

## Escalate

No. If live sessions on the shard show `MARKET_DATA_BAD` with it, say so in the channel.

## Related

[SHARD_LOG_DIGEST](SHARD_LOG_DIGEST.md), [COLLECTOR_SHARD_DOWN](COLLECTOR_SHARD_DOWN.md), [MARKET_DATA_BAD](MARKET_DATA_BAD.md), [STREAM_STALE](STREAM_STALE.md)
