---
type: GATEWAY_UNATTRIBUTED_ORDERS
summary: An order gateway found orders at the venue that no session claimed, and cancelled them.
first_steps:
  - Read the alert for the session and orders.
  - Check the venue for fills on those orders before they were cancelled, against the session's ledger.
---

## What it means

After a restart, or when a session new to the gateway said hello, the gateway reconciled the orders it holds with the ones the session lists, and found orders resting at the venue that the session doesn't know (`GATEWAY_UNATTRIBUTED_EVENTS` in its log). It cancelled them.

## Impact

Any fills those orders had before the cancel may be missing from the session's ledger, so its position can be wrong until reconciliation (Treasury) catches it.

## Diagnose

- The gateway log line names the session and the order's counter.
- The venue's fills on the account around then, against `ledger.fill`.

## Resolve

- Book any missing fills with a ledger adjustment, or let the venue poller's reconciliation flag them.
- Find why the session lost track: a crash with its journal behind, or a gateway restart whose reports were lost.

## Escalate

If fills are missing from the ledger.

## Related

[RECON_MISMATCH](RECON_MISMATCH.md), [GATEWAY_ORDERS_UNANSWERED](GATEWAY_ORDERS_UNANSWERED.md)
