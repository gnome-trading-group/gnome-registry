---
type: PAPER_GATEWAY_OVERLOADED
summary: A paper order gateway's books have lagged the market by more than 5 ms at p99 for five minutes running.
first_steps:
  - Read the labels for records/s, streams and books.
  - Check whether the venue's markets are unusually busy (a game going live) or the gateway's host is saturated.
---

## What it means

The gateway counts how late each new record reaches its books after the venue sent it. Over 1% of them later than 5 ms means the p99 lag is past 5 ms; five minutes of that raises this alert, and the first minute back under clears it. Its caps keep new sessions out once it holds enough books and streams, so this is usually its sessions' markets getting busier after they joined, or a shard feeding it slowly.

## Impact

Paper fills and quotes are judged against a stale book, so paper results drift from what live trading would see. Nothing is lost and no session is refused.

## Diagnose

- The gateway's minute line: books, streams, records/s, worst lag and the share late.
- The gateway's samples: `paper.lag` against `feed.network` and `feed.shard_wait`. A late shard shows in `feed.shard_wait`; a busy gateway in `paper.queue` and its host CPU.
- The shard publishing its streams (its own lag samples), if the network or shard wait is the larger part.

## Resolve

- A busy market passes; if it lasts, sessions move to quieter instances only when they relink (a gateway restart moves them all, cancelling their paper orders).
- A slow shard is the collection side's: see its own alerts.
- Persistent overload at normal rates means the caps are too high for the host; lower `gateway.paper.max.books` or `gateway.paper.max.streams`.

## Escalate

No.

## Related

[PAPER_GATEWAY_FULL](PAPER_GATEWAY_FULL.md)
