---
type: GATEWAY_DEGRADED
summary: An order gateway has been DEGRADED for 2 minutes: an account's lane or venue connection isn't healthy.
first_steps:
  - Read the gateway log `/gnome/order-gateway/<region>` for the account that went down (connection, reader or lane lines).
  - Check the venue's status page.
  - Check its sessions on the controller for orders rejected `GATEWAY_DEGRADED` or held.
---

## What it means

The gateway's state in its endpoint item has been DEGRADED on two reconciler ticks in a row. The gateway is up and linked to its sessions, but at least one account isn't READY: its order connection, its reader (the venue's order feed) or its lane.

## Impact

New orders on the affected account are refused or wait; cancels wait for the account to recover. Orders already resting stay at the venue, and are watched again only once the reader recovers.

## Diagnose

- The gateway log for that account: connect failures (logged once a minute), reader reconnects, venue 429s (`VENUE_RATE_LIMITED`), the minute summary's unanswered orders.
- The venue: an outage, maintenance, or credentials revoked.

## Resolve

- A venue outage: wait; the gateway reconnects on its own. Consider a kill switch on the exchange if sessions keep trying.
- Credentials: fix the account's key in Secrets Manager; the gateway reads it when it reconnects.
- If it stays DEGRADED with the venue healthy, stop the gateway's task; ECS replaces it while sessions want it.

**A paper gateway, and one that can't keep up.**

A paper gateway has no venue connection, so it isn't DEGRADED for these reasons. What goes wrong with one instead is
load: one thread simulates every paper session's books on its venue, and if it falls behind the market, paper fills
come from a stale book. Its log line every minute reads `Gateway paper-<exchange>: N orders working, N sessions, books'
worst lag N ms, N new orders refused for a book without data`:

- `books' worst lag` is the oldest new record a book took that minute, from the venue's receipt. A few to tens of ms is
  normal; one spike of seconds is usually a shard moving (its log shows streams marked bad, `its Aeron image went
  away`); hundreds of ms every minute means the gateway is overloaded.
- Measured: one `c7a.medium` holds about 30 paper sessions (~180 books) with lag under ~50 ms and CPU near 30%, and
  falls behind at 50 sessions (~300 books: lag 300–600 ms, CPU over 50%). If a venue regularly runs more than ~30 paper
  sessions, move its paper hosts to `c7a.large` (gnome-orchestrator CDK).
- `new orders refused for a book without data` rising: sessions sending before the gateway's copy of a quiet book has
  its first record (it clears on the shard's next re-send, within ~5 s), or a session whose simulation couldn't be built.

## Escalate

If orders are resting and the account stays down for more than 15 minutes.

## Related

[GATEWAY_VENUE_RATE_LIMITED](GATEWAY_VENUE_RATE_LIMITED.md), [GATEWAY_ORDERS_UNANSWERED](GATEWAY_ORDERS_UNANSWERED.md)
