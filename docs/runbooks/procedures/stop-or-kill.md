# Stop or kill

Two ways to stop trading, with different consequences.

## Kill switch

A `KILL_SWITCH` risk policy halts trading for its target: the OMS cancels the target's orders and refuses new ones,
within about a second of the risk refresh. The session keeps running, so it can still cancel, report and recover.
Enable one on the controller's Risk Policies page (`/risk/policies`), scoped as narrowly as the problem:

| Scope | Halts |
|---|---|
| Session | one running session |
| Strategy + listing | one strategy on one market |
| Strategy + exchange | one strategy on one venue |
| Strategy | every session of the strategy, live and paper |
| Exchange | everything on one venue |
| Account | every live order on one venue account, whichever strategy's (order gateway only) |
| Global | everything |

Live sessions trade through the order gateway, which enforces the same kills a second time, behind the OMS: within
about a second it refuses new orders a kill covers and cancels the covered orders it holds. An account kill is the
gateway's alone (the OMS never sees it); set it from the Treasury page (account row → Halt account).

A kill only works while the session's process (or for live, the order gateway) is alive and can reach the registry.
Disabling it lets trading resume.
Turning one on yourself posts an INFO alert; the OMS turning one on pages.

## Stop

Stopping a session (session page → Stop) marks it STOPPING, kills it, waits a few seconds for the OMS to cancel, then
terminates its instance. Its kill is released once the instance is gone. Use it when the session should not come
back, or when it's unhealthy and a kill isn't enough. A stop never alerts.

## When the process is dead

Neither can reach a process that has exited or hung: check the venue directly ([check-venue-orders](check-venue-orders.md)),
then stop the session so its instance and listings are released.

## When the order gateway is broken: emergency cancel

Every live order goes through the order gateway, so a hung or crash-looping gateway leaves orders resting that
neither a kill nor a stop can cancel, and Kalshi and Polymarket US cancel nothing on their own. The `EmergencyCancel`
Lambda goes around it: it lists the account's open orders on the venue with the account's trading key, cancels each,
and lists them again. It cancels every strategy's orders on that account. Each call raises an `EMERGENCY_CANCEL`
alert with the counts, the person and the reason.

- From the controller: Treasury, the account's row menu, Emergency cancel (needs a reason).
- Without the controller or the registry, from a laptop with prod access, in the region the account's exchange
  trades from (the region its order gateway runs in; the exchange's `region` in the security master):

  ```
  aws lambda invoke --profile prod --region <exchange region> --function-name EmergencyCancel \
    --cli-binary-format raw-in-base64-out \
    --payload '{"exchange":"KALSHI","secretName":"gnome/accounts/<label>/trading","reason":"<why>","actor":"<you>"}' \
    /dev/stdout
  ```

  `exchange` is the registry's code: `KALSHI`, `POLYMARKET_US` or `POLYMARKET_INTL`. Called from another region, the
  venue refuses the cancels and the answer lists them as failed.

  It answers what was open before, what failed and what is still open. `"dryRun": true` only lists. It is never
  retried on its own: run it again if anything is still open. Then halt the account on Treasury until the gateway is
  fixed.
