---
type: GATEWAY_SWEEP_FAILED
summary: A restarted order gateway can't list its account's open orders, so orders an earlier gateway left may still rest unowned.
first_steps:
  - Read the gateway's log for "can't list its open orders to sweep them" and the venue's error.
  - Check the account's open orders on the venue directly, or with EmergencyCancel in dry-run mode.
---

## What it means

At startup the gateway lists every order resting on each account and, once sessions have had their chance to claim them, cancels those placed before it started that it has no record of (an earlier gateway whose state didn't reach this one). It has been unable to list them for five minutes; it keeps trying every 10 s.

## Impact

Orders an earlier gateway left may rest at the venue with no gateway or session managing them. They can fill, and the fills reach no ledger.

## Diagnose

- The gateway log line carries the venue's error (auth, rate limit, timeout, outage).
- The venue's status page, and whether the gateway's own orders are going through (`GATEWAY_ORDERS_UNANSWERED`).
- `EmergencyCancel` with `"dryRun": true` lists the account's open orders without touching them.

## Resolve

- A venue outage: it resolves itself once the list succeeds.
- Otherwise, cancel the unowned orders with EmergencyCancel (it cancels every order on the account, so halt the account first if sessions are trading) and fix what stops the list.

## Escalate

If the venue lists orders nobody can account for, or it lasts past 30 minutes.

## Related

[GATEWAY_UNATTRIBUTED_ORDERS](GATEWAY_UNATTRIBUTED_ORDERS.md), [EMERGENCY_CANCEL](EMERGENCY_CANCEL.md)
