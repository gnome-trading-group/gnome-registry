---
type: RECON_STALE
summary: A venue account's balances can't be read; live launches on it are refused.
first_steps:
  - Read the error on Treasury for the account.
  - Check its read-only credentials.
  - Record a manual snapshot if the poller is down.
---

## What it means

The venue poller's latest reading failed, or there's no reading newer than the account's snapshot age (15 minutes by default).

## Impact

Reconciliation stops for the account and live launches on it are refused. Running sessions are unaffected.

## Diagnose

The error text says why: a missing read secret (the accounts seeded by migration 036 have none until their credentials are updated), revoked keys, or the venue being down ([accounts](../procedures/accounts.md)).

## Resolve

Update the account's credentials, or record a manual snapshot on Treasury while the poller is fixed.

## Escalate

No.

## Related

[accounts](../procedures/accounts.md), [Registry](../cloudwatch/Registry.md)
