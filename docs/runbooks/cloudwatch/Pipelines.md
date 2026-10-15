---
type: Pipelines
summary: A gnome-pipelines trigger or status function failed.
first_steps:
  - Open the alarm to see which function.
  - Read its logs (gnome-pipelines-trigger or gnome-pipelines-status).
  - Re-run any scheduled pipeline that didn't start.
---

## What it means

Alarms named `Pipelines-…`: the `gnome-pipelines-trigger` function failed to start a run (ECS refused the task, or the definition is broken), or `gnome-pipelines-status` failed while recording a stopped task. A scheduled run that never starts only shows here, never as `PIPELINE_FAILED`.

## Impact

Scheduled pipelines don't run, or a failed run isn't marked or alerted; whatever reads their output (a launcher rule, a model) works from stale data. Trading is otherwise unaffected.

## Diagnose

The function's CloudWatch logs. A trigger failure names ECS's reason; the run it created is marked FAILED on the controller's Research → Pipelines page.

## Resolve

Fix the cause in gnome-pipelines (its `cdk/lambda` handlers or `RunStack`), then trigger the run again from the Pipelines page.

## Escalate

No, unless a launch depends on the run and the window is closing.

## Related

[PIPELINE_FAILED](../alerts/PIPELINE_FAILED.md)
