---
type: GATEWAY_KILLS_STALE
summary: An order gateway hasn't read the registry's kill switches for 30 seconds.
first_steps:
  - Check the registry API is up (`docs/runbooks/procedures/registry-down.md`).
  - Read the gateway log `/gnome/order-gateway/<region>` for the kill read's error.
  - To halt trading now, stop the sessions or run the emergency cancel: a new kill switch won't reach this gateway.
---

## What it means

The gateway re-reads the enabled `KILL_SWITCH` rows every second, to refuse covered orders and cancel covered sessions' orders. Its reads have failed for 30 seconds.

## Impact

Kill switches already in force keep holding. A kill switch turned on now isn't seen, so the gateway won't halt the sessions it covers. The OMS's own checks still apply in sessions that read the kill themselves.

## Diagnose

- The gateway log's error for the read: registry 5xx, timeouts, the API key rejected.
- The registry's API and database health.

## Resolve

- Restore the registry; the alert resolves on the next good read.
- Until then, halt by stopping sessions (`strategy-sessions/stop`) or with `EmergencyCancel` for the account.

## Escalate

Yes, in prod, while live sessions are trading.

## Related

[GLOBAL_HALT](GLOBAL_HALT.md), [GATEWAY_FATAL](GATEWAY_FATAL.md)
