# Inspect a session

Everything about one strategy session: what it's doing, what it said last, and the machine it runs on.

## The controller

`/sessions/<session id>` shows its status, its last heartbeat and the health of each part (agents, gateways, ledger,
risk), its bound accounts and its recent logs. `/system` → Trading fleet shows the instance behind it.

## Logs

The orchestrator logs to `/var/log/gnome/orchestrator.log` on the instance, shipped to CloudWatch Logs as log group
`/gnome/orchestrator/<launch region>`, stream `ec2/<instance id>` (both on the session page):

```
aws logs tail /gnome/orchestrator/<region> --log-stream-names ec2/<instance-id> --since 30m --profile prod --region <region>
```

Look for `FATAL_ERROR_EXITING`, `UNKNOWN_ERROR`, `STRATEGY_LATCHED`, `LEDGER_FAILING_HALTED`, `RISK_UNGUARDED`,
`MARKET_DATA_GAP`, `RATE_LIMIT_THROTTLING` and `SOCKET_*`.

## The instance

Instances have no SSH; use Session Manager:

```
aws ssm start-session --target <instance-id> --profile prod --region <region>
sudo systemctl status gnome-strategy
sudo tail -200 /var/log/gnome/orchestrator.log
```

A process that is alive but not progressing can be thread-dumped with `sudo kill -3 <pid>` (the dump goes to the
orchestrator log) before it's stopped. The instance shuts itself down about 10 seconds after the process exits.
