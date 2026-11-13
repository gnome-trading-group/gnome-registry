---
type: CLOCK_UNSYNCED
summary: The session host's clock has no time source, can be more than 1 ms from UTC, or its clock status stopped updating.
first_steps:
  - Read the heartbeat's clock (source, errorBoundNanos, ageMs) on the session's page in the controller.
  - Over SSM, run chronyc tracking and chronyc sources on the instance.
  - Check gnome-clock-status and gnome-clock-setup with systemctl status.
---

## What it means

Every session host disciplines its clock with chrony: to the Nitro hardware clock (source `PHC`, about 20 µs from UTC) when it launched into the region's precision-time placement group, otherwise to Amazon Time Sync over NTP (`NTP`, about 0.1 ms, or about 0.5 ms on a burstable type). The `gnome-clock-status` service writes the clock's state to `/run/gnome/clock.status` every 10 s and the heartbeat reports it. This fires on three ticks running when chrony has no source it trusts (`UNSYNCED`), its error bound is over 1 ms, or the status is over a minute old (the writer stopped, so the reading is stale).

## Impact

Trading is unaffected. Latency figures that compare this host's timestamps with another host's or a venue's (market data from a shard, tick-to-trade through a gateway) are off by up to the error bound while it lasts; same-host figures are unaffected.

## Diagnose

- `chronyc tracking`: `Reference ID` names the source (`PHC0` or `169.254.169.123`); `Leap status: Not synchronised` means no source. `chronyc sources -v` shows whether each source is reachable.
- `systemctl status gnome-clock-status`: stopped or failing means the status is stale, not the clock.
- `journalctl -u gnome-clock-setup`: whether the host found the hardware clock at boot ("chrony now follows /dev/ptp…") or stayed on Amazon Time Sync, and why.
- The link-local time service shares a 1,024 packets-per-second limit with instance metadata and DNS; a process flooding either can starve chrony.

## Resolve

- Status writer stopped: `systemctl restart gnome-clock-status`.
- No source: `systemctl restart chronyd`; if Amazon Time Sync is unreachable from the instance, the next launch is the fix (a session's clock can't be repaired under it safely).
- A wide bound on NTP is normal on a burstable instance under load; launch latency-sensitive sessions on a non-burstable type.

It's fixed once the heartbeat shows a bound under 1 ms and a fresh status.

## Escalate

Escalate if every host in a region reports it at once (Amazon Time Sync or the region's hardware clock is down).

## Related

[inspect-session](../procedures/inspect-session.md), [HOST_CPU_HIGH](HOST_CPU_HIGH.md)
