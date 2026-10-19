---
type: JOURNAL_BACKLOG
summary: The session's journal segments aren't reaching S3; they wait on the instance's disk.
first_steps:
  - Read the shipper's log stream ec2/<instance>/journal-shipper in CloudWatch.
  - Check gnome-journal-shipper is running (systemctl status, over SSM).
  - Watch disk space; a long backlog ends in DISK_LOW.
---

## What it means

The JVM seals a journal segment every minute and the `gnome-journal-shipper` service on the instance compresses it, uploads it to `s3://gnome-journals-<stage>/<sessionId>/` and deletes it. Three or more sealed segments are still on disk, or one has waited five minutes, on two ticks running.

## Impact

Trading is unaffected. The session's journal (and its strategy metrics) is incomplete in S3 until the backlog clears, and a session lost now loses what hasn't shipped. The backlog grows by a segment a minute until the disk fills (DISK_LOW).

## Diagnose

- The shipper's log (`/var/log/gnome/journal-shipper.log`, in CloudWatch as `ec2/<instance>/journal-shipper`) names each failed upload and why: S3 access, the network, the bucket.
- No recent lines at all: the shipper has stopped. `systemctl status gnome-journal-shipper` over SSM ([inspect-session](../procedures/inspect-session.md)).
- `ls -la /var/lib/gnome/journal/<sessionId>/` shows the waiting `.done` segments.

## Resolve

- Shipper stopped: `systemctl restart gnome-journal-shipper`; it catches up on its own.
- Uploads failing: fix the cause (the instance role's `s3:PutObject` on the bucket, the bucket, the network); the shipper retries each segment.

It's fixed once the backlog is under three segments.

## Escalate

Escalate if the disk is filling faster than it can be fixed (DISK_LOW).

## Related

[DISK_LOW](DISK_LOW.md), [inspect-session](../procedures/inspect-session.md)
