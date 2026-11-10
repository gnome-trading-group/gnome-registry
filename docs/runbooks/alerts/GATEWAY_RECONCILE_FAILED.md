---
type: GATEWAY_RECONCILE_FAILED
summary: The gateway reconciler failed to reconcile one gateway on 3 ticks in a row.
first_steps:
  - Read `/aws/lambda/GatewayReconciler` (us-east-1) for the lines naming the gateway.
  - Check the error: task definition registration, Elastic IP allocation, or the ECS service update.
---

## What it means

Each minute, and whenever a session asks, the reconciler decides whether each gateway should run, then registers its task definition revision, makes sure it has an Elastic IP and sets its ECS service. For this gateway that failed on the last 3 ticks; other gateways are reconciled independently.

## Impact

The gateway isn't started, stopped or moved to a new release as it should be. If it is wanted and down, live sessions on that venue can't trade.

## Diagnose

- The error in the reconciler log: `AccessDenied` (its role), `ClientException` on the base task definition `order-gateway` (OrderGatewayStack not deployed in that region), the Elastic IP limit reached in the region, the ECS cluster or capacity provider missing.
- Whether the gateway's row in the registry (`GET /gateways?mode=live`) names a region the platform runs in.

## Resolve

- Fix the cause; the next tick catches up.
- Elastic IP limit: release unused addresses in the region, or raise the quota.

## Escalate

No, unless live sessions need the gateway now.

## Related

[GATEWAY_START_STUCK](GATEWAY_START_STUCK.md), [GatewayReconciler](../cloudwatch/GatewayReconciler.md)
