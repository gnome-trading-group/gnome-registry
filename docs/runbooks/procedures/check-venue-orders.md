# Check the venue for resting orders and positions

When a live session dies, hangs or is stopped without its kill switch, orders it placed can stay on the venue with
nothing managing them. The OMS cancels everything on a clean shutdown (`OmsAgent.onClose` → `shutdownCancelAll`), but
not if the process is killed, runs out of memory, hangs, or its order gateway is down. No venue cancels our orders
for us when we disconnect.

1. Find which account the session traded: the session page in the controller shows its bound venue accounts, or the
   Treasury page lists every account by exchange.
2. Open the venue and look at that account's open orders and positions:
   - **Kalshi:** TODO(owner): where to see open orders for an account/subaccount and how to mass-cancel.
   - **Polymarket US:** TODO(owner): same.
   - **Polymarket Intl:** TODO(owner): same, for the wallet (funder address on the Treasury page).
3. Cancel anything the session left behind, unless a session that is still running owns it.
4. Compare positions with the ledger (controller → Fills & Orders, or Treasury → reconciliation). A difference the
   ledger can't explain will show up as RECON_MISMATCH within minutes; adjust the ledger only once you know why.

If you can't reach the venue or can't cancel, escalate immediately: the exposure is open until someone does.
