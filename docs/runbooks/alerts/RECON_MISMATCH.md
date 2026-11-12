---
type: RECON_MISMATCH
summary: A venue account's cash or a position disagrees with the ledger.
first_steps:
  - Open Treasury → reconciliation for the account.
  - Compare the venue's balance and positions with the ledger.
  - Stop strategies on the account if the gap is unexplained.
---

## What it means

The venue poller's reading differs from what the ledger and recorded transfers explain, for over 5 minutes with nothing booked to explain it, or the venue holds a position the ledger doesn't know.

## Impact

Something traded or moved money that the ledger didn't record (or recorded wrongly). Risk limits are computed from the ledger.

## Diagnose

Treasury shows the expected and venue figures. Look for money the venue poller didn't book (the snapshot's raw `creditsErrors` says when it couldn't read the venue's credits; money taken out under a type it doesn't know is deliberately left for this alert), fills missed by a fenced or failing ledger, manual trades on the venue, or settlement payouts ([accounts](../procedures/accounts.md)).

## Resolve

Once you know what happened: if the poller couldn't read credits, fix that and it books them on its next run; otherwise record a `CORRECTION` (deposits and withdrawals on polled venues are the poller's to book), or adjust the ledger.

## Escalate

Escalate if money is missing and unexplained.

## Related

[accounts](../procedures/accounts.md), [check-venue-orders](../procedures/check-venue-orders.md)
