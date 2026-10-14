# Venue accounts runbook

Venue accounts are the accounts strategies trade through on each exchange. Kalshi and Polymarket US have one each;
Polymarket Intl keeps a pool of wallets that are rotated, because every wallet's trades and PnL are public on chain.
Credentials live only in Secrets Manager (`gnome/accounts/<label>/{trading,read}`); the registry stores secret names
and public identifiers, never keys.

Lifecycle: `PROVISIONING` → `ACTIVE` → `DRAINING` → `RETIRED` (a draining account may go back to `ACTIVE`).

## Register a new account

1. **Polymarket Intl only:** create the wallet (UI or script) without a public username, derive its L2 API keys, and
   fund it **directly from a CEX withdrawal**. Never fund it from another of our wallets, and never fund gas or
   approvals from a shared address: either links the wallets publicly.
2. On the **Treasury** page, click **Register account**, pick the exchange and enter the credentials (or upload them:
   a JSON file for Polymarket, the `.pem` key file for Kalshi). For Kalshi and Polymarket US, add read-only
   credentials for the poller if the venue issues them.
   The registry draws a gamer-tag label (e.g. `sleepy-otter-42`), stores the credentials in Secrets Manager as
   `gnome/accounts/<label>/trading` (and `/read`) in every trading region, derives the public identifiers (wallet
   addresses, Kalshi subaccount) from them, and registers the account as `PROVISIONING`. The credentials are never
   written to the database or logged; the dialog shows where they were stored.
3. Wait for the venue poller to post a green balance snapshot (Treasury page).
4. Record the account's `OPENING` transfer: the cash it holds now. Reconciliation starts there.
5. Set the account's buffer and thresholds, then **Activate** it.

## Rotate a Polymarket Intl wallet

1. Register and activate the new wallet.
2. **Drain** the old one. Every session still bound to it is kill-switched at once.
3. Relaunch those sessions: auto-pick binds them to an active wallet. A strategy still holding positions in the old
   wallet starts flat on the new one; the old positions stay where they are (moving tokens would link the wallets).
   A strategy with open orders left on the old wallet can't move until they are cancelled.
4. Once the old wallet's markets resolve, redeem in the Polymarket UI and withdraw to a **fresh deposit address for
   that wallet** (or a separate CEX sub-account): CEX deposit addresses are usually fixed per user, so sending every
   retired wallet to the same one clusters them publicly. Record the `WITHDRAWAL`.
5. When the Treasury page says it is ready, **Retire** it, then choose **Delete secrets** from its menu (recoverable
   from the Secrets Manager console for 7 days).

## Linkage hygiene

Rotation hides the firm's aggregate PnL and deters casual copy-trading; it does not defeat determined clustering.
Behaviour links wallets too (identical sizes, quoting at the same moment, the same markets). Check Polymarket's terms
on multiple wallets before scaling up.

## Launch checks

A live session is refused unless every listing it trades is covered by MAX_COMMITTED_CAPITAL, MAX_TOTAL_PNL_LOSS,
MAX_POSITION and MAX_CONSECUTIVE_REJECTS, the strategy has a MAX_COMMITTED_CAPITAL for each exchange, and the bound
account's latest balance snapshot is fresh with room for the strategy's budget. Paper sessions are never checked. If
the poller is down, record a manual snapshot on the Treasury page.
