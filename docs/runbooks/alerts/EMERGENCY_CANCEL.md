---
type: EMERGENCY_CANCEL
summary: Someone cancelled every open order on a venue account around the order gateway.
first_steps:
  - Read the body: how many orders were open, how many failed to cancel, how many are still open.
  - If any are still open, run it again, or cancel them in the venue's UI.
  - Find out why the gateway couldn't be trusted to cancel, before trading resumes on the account.
---

## What it means

The `EmergencyCancel` Lambda (gnome-orchestrator, one in every platform region, run in the region the account's
exchange trades from) listed the account's open orders straight from the venue with its trading key, cancelled
each, and listed them again. It goes around the order gateway entirely, so it is used when the gateway is broken,
hung, or not trusted. The actor and reason are in the alert. A dry run only lists, and is INFO.

## Impact

Every strategy's orders on the account were cancelled, whichever strategy placed them. Positions are untouched. If the
gateway is still running it may place new orders unless the account is also halted.

## Diagnose

- The body gives the counts; the function's log (`/aws/lambda/EmergencyCancel` in its region) lists any order that
  failed and why, and the ids still open.
- Check the order gateway: is it running, are its lanes moving, what did it log before this
  ([inspect-session](../procedures/inspect-session.md) for the gateway's log group).

## Resolve

- Still-open orders: run it again (it is never retried on its own), or cancel them on the venue
  ([check-venue-orders](../procedures/check-venue-orders.md)).
- Halt the account on Treasury (account row, Halt account) until the gateway is fixed, so nothing new goes out.
- Once the gateway is healthy, resume the account; sessions reconcile their orders against the venue on their own.

## Escalate

If orders stay open after a second run and the venue's UI can't cancel them: contact the venue.

## Related

[stop-or-kill](../procedures/stop-or-kill.md)
