---
type: Controller
summary: A controller backend alarm fired.
first_steps:
  - Open the alarm to see which part.
  - Read the function's logs.
  - Check the controller still loads.
---

## What it means

Alarms named `Controller-…`: the controller API's errors. Pipeline functions alarm as `Pipelines-…`.

## Impact

The UI; trading is unaffected.

## Diagnose

The function's CloudWatch logs.

## Resolve

Fix and redeploy.

## Escalate

No.

## Related

[Pipelines](Pipelines.md)
