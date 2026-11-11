---
type: PIPELINE_FAILED
summary: A data or research pipeline run failed, or a polling source crashed too often and stopped.
first_steps:
  - Open the run on the controller's Research → Pipelines page.
  - Read its logs.
  - Re-run it (or start the source again) once fixed if trading depends on it.
---

## What it means

A gnome-pipelines run (a Fargate task) exited with an error. Scheduled runs are ERROR because some feed trading (each cs2_upcoming run triggers the launcher's cs2 rule); manual runs are INFO.

A polling source (label `kind: source`, e.g. `cfb_qb_status`) runs until stopped and is restarted whenever its task stops unasked; this alert means its task crashed 3 times in 30 minutes (or couldn't be started again), so the run is FAILED and nothing is polling. Always ERROR, however it was started.

## Impact

Whatever reads its output (a launcher rule, a model) works from stale data until it runs again.

## Diagnose

The run's logs in the controller or CloudWatch (the `gnome-pipelines` task's log group).

## Resolve

Fix and re-run it from the Pipelines page. For a polling source, press Start again; its state (spend counters, read caches) carries over from S3.

## Escalate

No, unless a launch depends on it and the window is closing.

## Related

[Pipelines](../cloudwatch/Pipelines.md)
