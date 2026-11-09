---
type: ACCOUNT_HALT
summary: All trading on one venue account is halted.
first_steps:
  - Check the reason and who turned it on (By:).
  - Confirm the account has no orders left resting on the venue.
  - Fix the cause, then resume the account on Treasury.
---

## What it means

A kill switch is on for one venue account. Only the order gateway acts on it, so it halts live trading on that
account whichever strategy's orders they are: the gateway cancels every working order on the account and refuses
new ones until it's resumed. The OMS doesn't see it, so sessions keep running and see their orders refused `HALTED`.

## Impact

Live trading on the account is halted; positions stay as they are. Other accounts on the same venue are untouched.

## Diagnose

The alert names who turned it on (`By:`) and why. Treasury shows the account as halted, and the Risk Policies page
the policy and its history. The order gateway logs `Gateway kill in force: account <id>` when it takes effect.

## Resolve

Fix whatever led to the halt, then resume the account on Treasury (account row menu, Resume account), which resolves
this alert. If the order gateway itself is broken and orders still rest, use the emergency cancel
([stop-or-kill](../procedures/stop-or-kill.md)).

## Escalate

If orders still rest on the venue a minute after the halt and the emergency cancel doesn't clear them, escalate.

## Related

[stop-or-kill](../procedures/stop-or-kill.md), [check-venue-orders](../procedures/check-venue-orders.md),
[EMERGENCY_CANCEL](EMERGENCY_CANCEL.md)
