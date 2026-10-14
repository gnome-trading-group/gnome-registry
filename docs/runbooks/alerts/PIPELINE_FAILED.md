---
type: PIPELINE_FAILED
summary: A data or research pipeline run failed.
first_steps:
  - Open the run on the controller's Research → Pipelines page.
  - Read its logs.
  - Re-run it once fixed if trading depends on it.
---

## What it means

A gnome-pipelines run (a Fargate task) exited with an error. Scheduled runs are ERROR because some feed trading (cs2_prematch_predict drives a launcher rule); manual runs are INFO.

## Impact

Whatever reads its output (a launcher rule, a model) works from stale data until it runs again.

## Diagnose

The run's logs in the controller or CloudWatch.

## Resolve

Fix and re-run it from the Pipelines page.

## Escalate

No, unless a launch depends on it and the window is closing.

## Related

[Controller](../cloudwatch/Controller.md)
