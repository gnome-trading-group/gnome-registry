# When the registry is down

The registry (API Gateway + Lambdas + Postgres in us-east-1) is the control plane. When it's unreachable:

- **Running sessions protect themselves.** Risk policies stop refreshing, and 30 seconds later the OMS refuses new
  orders (`risk.stale.after.ms`). Resting orders are not cancelled by staleness alone.
- **Ledger writes queue** in each session and are retried; a session whose ledger falls 10 seconds behind halts
  itself (LEDGER_FAILING).
- **Heartbeats stop landing**, so every session looks silent at once: expect SESSIONS_SILENT_MULTIPLE.
- **Launches and stops fail**, and kill switches can't be changed through the controller.
- **Alerting keeps delivering** reported events and CloudWatch alarms (marked "not recorded"), but the rule tick needs
  the database, so `AlertingMeta-` alarms fire.

## Check

1. `/system` (if the controller loads) → Databases and Services.
2. AWS console → RDS → the registry instance: status, storage, CPU, connections.
3. API Gateway → the registry API's 5xx rate; Lambda → errors on the endpoint functions.

## Recover

Restore the database or API first; sessions resume on their own once risk refreshes again. If it will be down long
and sessions are live, check the venues ([check-venue-orders](check-venue-orders.md)) and consider stopping sessions
from the EC2 console (terminating the instance runs the OMS's clean shutdown first).
