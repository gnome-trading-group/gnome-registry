---
type: RECONNECTING
summary: A gateway has been reconnecting for over a minute.
first_steps:
  - Check the venue's status page.
  - Open the session's logs for SOCKET_ lines.
  - Stop the session if the venue is down for long.
---

## What it means

A market-data or order gateway is reconnecting, on two ticks running.

## Impact

No market data (or no orders) through it while reconnecting. Ten gateway errors in a minute exit the session.

## Diagnose

Logs: `SOCKET_DISCONNECTED`, `SOCKET_CONNECT_FAILED`, `SOCKET_RECONNECTING`. Check the venue's status and our credentials.

## Resolve

Usually resolves when the venue recovers.

## Escalate

Escalate if an order gateway is down on a live session with resting orders.

## Related

[inspect-session](../procedures/inspect-session.md), [check-venue-orders](../procedures/check-venue-orders.md)
