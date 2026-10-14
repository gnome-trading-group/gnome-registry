---
type: RATE_LIMIT_THROTTLING
summary: A venue account is being rate limited; orders are being refused locally.
first_steps:
  - Check which account on the session page.
  - Look for VENUE_RATE_LIMITED in the logs.
  - Reduce the strategy's order rate or split it across accounts.
---

## What it means

The venue returned 429s or our limiter ran out of budget, for three ticks running. Requests are held and the budget halved.

## Impact

Orders are delayed or refused as RATE_LIMITED; cancels are never held back.

## Diagnose

Logs: `VENUE_RATE_LIMITED`, `RATE_LIMIT_THROTTLING`, `RATE_LIMIT_RECOVERED`.

## Resolve

Usually recovers on its own. If it persists, the strategy is sending too much for one account.

## Escalate

Escalate only if cancels are being refused.

## Related

[inspect-session](../procedures/inspect-session.md)
