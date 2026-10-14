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
| Global | everything |

A kill only works while the session's process is alive and can reach the registry. Disabling it lets trading resume.
Turning one on yourself posts an INFO alert; the OMS turning one on pages.

## Stop

Stopping a session (session page → Stop) marks it STOPPING, kills it, waits a few seconds for the OMS to cancel, then
terminates its instance. Its kill is released once the instance is gone. Use it when the session should not come
back, or when it's unhealthy and a kill isn't enough. A stop never alerts.

## When the process is dead

Neither can reach a process that has exited or hung: check the venue directly ([check-venue-orders](check-venue-orders.md)),
then stop the session so its instance and listings are released.
