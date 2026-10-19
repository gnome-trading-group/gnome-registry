---
type: HOST_CPU_HIGH
summary: The session's instance has been close to fully busy, or throttled, for ten minutes.
first_steps:
  - Open the session page; check busy against steal.
  - High steal on a t3 instance means it's out of CPU credits.
  - If orders are slow, stop the session and relaunch on a bigger instance.
---

## What it means

The session's heartbeat reports the instance's CPU, measured from `/proc/stat` between heartbeats. Either it was at least 90% busy across all cores, or at least 20% of its time was stolen by the hypervisor, for ten ticks running. Steal on a burstable (t3) instance is what running out of CPU credits looks like from inside it.

## Impact

Market data, the strategy and the OMS all share the instance's cores, so everything slows: decisions are made on older prices, and orders and cancels go out later. Nothing has stopped.

## Diagnose

- Steal high, busy moderate: the instance is throttled. Check `CPUCreditBalance` for the instance in CloudWatch.
- Busy high, no steal: something on the instance is using the CPU. `top` over SSM ([inspect-session](../procedures/inspect-session.md)) shows whether it's the strategy's process or the journal shipper; a shipper compressing a backlog runs at low priority and yields to the session.
- A Python strategy doing more work per tick than the instance has room for shows as the strategy's process.

## Resolve

Stop the session and relaunch it on a bigger instance, or on one that doesn't burst. It's fixed once a heartbeat shows busy under 90% and steal under 20%.

## Escalate

Escalate if a live session's orders are visibly late and stopping it would leave positions unmanaged.

## Related

[inspect-session](../procedures/inspect-session.md), [stop-or-kill](../procedures/stop-or-kill.md)
