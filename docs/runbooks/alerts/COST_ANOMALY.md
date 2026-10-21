---
type: COST_ANOMALY
summary: AWS Cost Anomaly Detection saw a service's spend jump well above its usual pattern.
first_steps:
  - Open the anomaly from the alert's link and read its root causes.
  - Check whether the named service is still spending at that rate.
---

## What it means

The `gnome-services` anomaly monitor learns each service's normal spend and reports when one runs at least $20 over what it expected. It hears about a runaway within hours, well before the monthly budget does.

## Impact

Money only. An anomaly that's still running keeps costing until whatever drives it stops.

## Diagnose

The root causes in the alert name the service, region and usage type. Cost Explorer for that service, hourly, shows when it started; CloudTrail for that time shows what was created or changed.

## Resolve

Stop the cause (instances left running, a loop invoking Lambdas or Bedrock, a job sweeping far more than intended). If the new spend is expected, mark the anomaly as accurate or not in the console so the monitor learns.

## Escalate

No, unless it's still growing and you can't find the cause.

## Related

[COST_BUDGET](COST_BUDGET.md)
