---
type: CLOUDWATCH_ALARM
summary: A CloudWatch alarm fired.
first_steps:
  - Open the alarm from the alert.
  - Read the service's runbook.
  - It resolves when the alarm returns to OK.
---

## What it means

A CloudWatch alarm entered ALARM. Its severity is the tier at the end of its name; it resolves when it leaves ALARM. Each service has its own runbook under cloudwatch/.

## Impact

Per the alarm.

## Diagnose

The alarm's metric and the service's logs.

## Resolve

Per the service's runbook.

## Escalate

Per the service's runbook.

## Related

[cloudwatch](../cloudwatch/)
