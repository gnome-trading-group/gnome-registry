---
type: VENUE_CREDIT_UNCLASSIFIED
summary: A venue paid the account something the venue poller doesn't recognise; it's booked but unlabelled.
first_steps:
  - Read the transfer on Treasury → Transfers (its reason is the venue's own type).
  - Map the type in the venue's reader under cdk/lambda/sync/venues.
---

## What it means

The venue poller reads every credit a venue reports on the account (rewards, rebates, interest, deposits,
withdrawals) and books it as a treasury transfer. This one came under a type its reader doesn't map, so it was
booked as a REWARD (or a CORRECTION, if it took money out) with program UNCLASSIFIED. Kalshi doesn't document its
credit types, so its first payout of each kind lands here.

## Impact

None on cash: the transfer is booked, so reconciliation still balances. It counts as firm-level non-trading PnL
and isn't given to any strategy, even if it was a reward a strategy earned.

## Diagnose

The transfer's reason holds the venue's type (and Kalshi's credit reason), and its raw column the venue's whole row.

## Resolve

Add the type to the venue's mapping: `CREDIT_PROGRAMS` in `kalshi.ts`, `CREDIT_TYPES` in `polymarket-intl.ts`,
`REWARD_TYPES` in `polymarket-us.ts`. Transfers already booked keep their program; the alert clears a week after the
payment.

## Escalate

No.

## Related

[accounts](../procedures/accounts.md)
