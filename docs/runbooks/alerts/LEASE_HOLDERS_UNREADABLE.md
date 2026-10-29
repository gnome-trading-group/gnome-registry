---
type: LEASE_HOLDERS_UNREADABLE
summary: The market-data reconciler hasn't been able to read the registry's strategy sessions for 15 minutes while sessions hold stream leases.
first_steps:
  - Check the registry API (`GET /api/strategy-sessions?status=RUNNING`) and its `strategysessions` Lambda's logs for errors.
  - Read the reconciler's log (`/aws/lambda/<Stage>-MarketDataReconcilerStack-Reconciler-v1`) for "Couldn't read the registry's sessions" and the error after it.
  - Check whether the registry's API key the reconciler uses (`REGISTRY_API_KEY_ID`) was rotated or removed.
---

## What it means

Every minute the collection reconciler (gnome-market-data) reads the registry's sessions that haven't ended, to release the stream leases of sessions that have and to extend those of running ones. It has failed to for 15 minutes. Meanwhile it releases a lease only once it is past its expiry and its session was not last seen STARTING or RUNNING; leases of sessions that may be trading are kept past their expiry until the registry answers.

## Impact

Running paper sessions keep their streams, so nothing breaks at once. Leases of sessions that ended during the outage are not released: their streams stay collected and published (cost only). Leases are not extended either; that is caught up on the first tick the registry answers.

## Diagnose

- The registry's own alarms (`Registry-*` API 5xx) and the `strategysessions` Lambda's errors.
- A 403 in the reconciler's log means its API key no longer works.

## Resolve

- Fix the registry or its key; the alert resolves on the first tick that reads the sessions, and that tick releases the leases of sessions that ended meanwhile.
- If the registry will be down for long and a session has ended, its lease can be released by hand: `DELETE collection/leases/{sessionId}` on the market-data API.

## Escalate

No: only paper sessions lease streams.

## Related

[LEASED_STREAM_UNPLACED](LEASED_STREAM_UNPLACED.md), [registry-down](../procedures/registry-down.md)
