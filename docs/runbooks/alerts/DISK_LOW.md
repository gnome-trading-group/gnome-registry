---
type: DISK_LOW
summary: The session's disk is nearly full; the session crashes when the journal can't start its next segment.
first_steps:
  - Check for a JOURNAL_BACKLOG on the same session; it's the usual cause.
  - Stop the session before the disk fills.
---

## What it means

The heartbeat reports the free space on the journal's disk. It's under 1 GB, or under two journal segments (512 MB with 256 MB segments), whichever is larger.

## Impact

The journal maps each new segment into memory; with the disk full, writing to it crashes the process and the session FAILS. A live session's resting orders stay on the venue until the OMS's recovery on the next launch.

## Diagnose

- A JOURNAL_BACKLOG alongside it: the shipper isn't uploading, so segments are piling up. Follow that runbook.
- No backlog: something else is filling the disk. `du -sh /var/lib/gnome /var/log/gnome /tmp` over SSM ([inspect-session](../procedures/inspect-session.md)).

## Resolve

Stop the session cleanly while there is still room: the shipper sends what's left as the instance shuts down. It's fixed once free space is back over the threshold.

## Escalate

Page whoever owns the live strategy if it can't be stopped cleanly.

## Related

[JOURNAL_BACKLOG](JOURNAL_BACKLOG.md), [stop-or-kill](../procedures/stop-or-kill.md)
