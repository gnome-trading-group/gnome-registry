---
type: GatewayReconciler
summary: The order gateway reconciler isn't ticking, keeps failing, or its queue is stuck.
first_steps:
  - Open the alarm to see which.
  - Read `/aws/lambda/GatewayReconciler` (us-east-1).
  - Check live gateways still start for sessions that want them (ECS cluster `order-gateways`).
---

## What it means

Alarms named `GatewayReconciler-…` (gnome-orchestrator's OrderGatewayReconcilerStack, us-east-1):

- `TickFailing-Error`: the minute schedule can't send its tick to the queue `gateway-reconciler.fifo` (EventBridge `FailedInvocations`).
- `NotRunning-Error`: the Lambda hasn't run for 5 minutes, from ticks or sessions' wake-ups.
- `Errors-Error`: runs keep failing as a whole (one gateway failing is `GATEWAY_RECONCILE_FAILED` instead).
- `QueueStuck-Error`: the oldest message has waited 5 minutes: a failing message holds the queue's one group.

## Impact

Gateways aren't started, stopped or moved to a new release. Running gateways keep serving their sessions; a session wanting a stopped gateway waits, and fails after 10 minutes. The reconciler's gateway alerts stop too.

## Diagnose

- TickFailing: the rule's target (the queue's name, its policy, content-based deduplication on the FIFO queue).
- NotRunning or QueueStuck: the Lambda's SQS trigger (enabled, its errors), throttling (reserved concurrency 1).
- Errors: the log's stack trace; usually the registry API (SSM `/gnome/registry/api-url`, the API key) or DynamoDB `service-endpoints`.

## Resolve

- Fix the cause; the next tick reconciles everything from scratch.
- A bad orchestrator release: roll back; the reconciler's code ships with it.

## Escalate

If live sessions need a gateway started and it can't be fixed within 30 minutes: start it by hand (set its ECS service to 1).

## Related

[GATEWAY_RECONCILE_FAILED](../alerts/GATEWAY_RECONCILE_FAILED.md), [GATEWAY_START_STUCK](../alerts/GATEWAY_START_STUCK.md)
