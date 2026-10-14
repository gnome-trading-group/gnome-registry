---
type: LISTING_HALT
summary: A listing is halted by a kill switch.
first_steps:
  - Check the reason and who turned it on (By:).
  - If automatic: confirm the venue has no orders left resting for this scope.
  - Fix the cause, then disable the kill switch on Risk Policies.
---

## What it means

A kill switch is on for one listing, for one strategy or for all of them (a starting session halts a listing it finds an order or position on that it can't account for). The OMS cancels that scope's orders and refuses new ones until it's disabled. A kill on a session being stopped is routine and never alerts.

## Impact

Trading is halted for the scope; positions stay as they are. The halt is the system protecting itself: nothing more is lost while it holds, but nothing is managed either.

## Diagnose

The alert names who turned it on (`By:`) and why. `oms` means the OMS escalated on its own: the reason says
which ("N consecutive venue rejects", "ledger failing" or "market risk limit breached (policy N)"). `session <id>
startup` is a starting session halting something it found on the venue and can't account for. No actor means it was
written straight to the database. The Risk Policies page shows the policy and its history; the session's logs show
the `STRATEGY_LATCHED` line and what led to it ([inspect-session](../procedures/inspect-session.md)).

## Resolve

Find and fix the cause first: a reject streak usually means insufficient funds, a closed market or a broken
order (the venue's reject text is in the logs); a market-risk breach means a limit was hit. Then disable the kill
switch on the Risk Policies page, which resolves this alert. If you turned it on yourself, this is only a record.

## Escalate

If it was automatic and you can't explain the reason within 15 minutes, escalate. If the venue still shows orders you can't cancel, escalate immediately.

## Related

[stop-or-kill](../procedures/stop-or-kill.md), [check-venue-orders](../procedures/check-venue-orders.md), [inspect-session](../procedures/inspect-session.md)
