---
type: Controller
summary: A controller backend alarm fired.
first_steps:
  - Open the alarm to see which part.
  - Read the function's logs.
  - Check the controller still loads.
---

## What it means

Alarms named `Controller-…`: the controller API's errors, or the research pipeline trigger and status functions failing (a scheduled pipeline run that never starts only shows here).

## Impact

The UI or scheduled pipelines; trading is unaffected.

## Diagnose

The function's CloudWatch logs.

## Resolve

Fix and redeploy; re-run any pipeline that didn't start.

## Escalate

No.

## Related

[PIPELINE_FAILED](../alerts/PIPELINE_FAILED.md)
