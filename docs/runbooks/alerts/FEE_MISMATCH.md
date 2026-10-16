---
type: FEE_MISMATCH
summary: A venue charged different fees than the schedule the registry holds for the listing.
first_steps:
  - Open the listing in Security Master and check its Fees timeline.
  - Compare with the venue's published fees for that market.
  - Record the venue's new schedule, or fix the listing's fee group or event.
---

## What it means

Over the last day, some live orders on this listing (Kalshi or Polymarket US) were charged more than a cent away from
what the registry's fee schedule says, worked out fill by fill in the order the venue matched them.

## Impact

Backtests and strategies price this listing with the wrong fees from then on. Live PnL is unaffected: the ledger books
what the venue actually charged.

## Diagnose

- The finding names the worst order; its fills are in the session's ledger.
- Security Master → the listing → Fees shows which schedule applied and where it came from (listing, fee event, fee
  group or exchange).
- A venue fee change: Kalshi publishes series and event changes (the classifier's fee sync records them within the
  hour); Polymarket US only announces them (docs.polymarket.us/fees, CFTC filings).
- A wrong mapping: the listing's fee group or fee event doesn't match its Kalshi series, event or Polymarket US sport.

## Resolve

Record the venue's schedule in Security Master → Fees, effective from when the venue changed it, or correct the
listing's fee keys. The finding clears once new fills match.

## Escalate

No.

## Related

[FEE_SCHEDULE_MISSING](FEE_SCHEDULE_MISSING.md)
