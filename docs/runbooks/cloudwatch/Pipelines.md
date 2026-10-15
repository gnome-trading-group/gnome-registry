---
type: Pipelines
summary: A gnome-pipelines trigger or status function failed.
first_steps:
  - Open the alarm to see which function.
  - Read its logs (gnome-pipelines-trigger or gnome-pipelines-status).
  - Re-run any scheduled pipeline that didn't start.
---

## What it means

Alarms named `Pipelines-…`, one per gnome-pipelines function:
- `Trigger`: a run couldn't start (ECS refused the task, or a schedule names a pipeline or parameters the code no longer accepts). A scheduled run that never starts only shows here, never as `PIPELINE_FAILED`.
- `Status`: recording a stopped task failed, so a failed run may not be marked or alerted.
- `Sync`: making the EventBridge schedules match the published manifest failed; schedules keep the previous manifest's expressions and parameters.
- `Api` (warning): the Pipelines page's API returned an error.

## Impact

Scheduled pipelines don't run, or a failed run isn't marked or alerted; whatever reads their output (a launcher rule, a model) works from stale data. Trading is otherwise unaffected.

## Diagnose

The function's CloudWatch logs. A trigger failure names ECS's reason; the run it created is marked FAILED on the controller's Research → Pipelines page.

## Resolve

Fix the cause in gnome-pipelines (its `cdk/lambda` handlers or `RunStack`), then start the run again from the Pipelines page. A failed sync is retried by re-running the image workflow (it can be started by hand), which republishes the manifest.

## Escalate

No, unless a launch depends on the run and the window is closing.

## Related

[PIPELINE_FAILED](../alerts/PIPELINE_FAILED.md)
