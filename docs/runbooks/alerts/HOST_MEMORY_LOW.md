---
type: HOST_MEMORY_LOW
summary: The session's instance has under 10% of its memory available; the kernel will kill the process if it runs out.
first_steps:
  - Open the session page; compare process RSS with the JVM heap.
  - If it keeps falling, stop the session before it's killed.
  - Relaunch on an instance with more memory.
---

## What it means

The heartbeat reports `MemAvailable` from `/proc/meminfo`: memory the kernel can hand out without swapping, page cache it can drop included. It was under 10% of the total on two ticks running.

## Impact

If it reaches zero, the kernel's out-of-memory killer ends the session's process, which then raises FAILED. Until then the session runs normally.

## Diagnose

The finding carries the process's resident memory (RSS) and the JVM heap. For a Python strategy RSS covers Python and the JVM together:

- RSS much larger than the heap: the memory is Python's (the strategy's own data, models, pandas).
- Heap near its maximum: the JVM; take a heap histogram over SSM with `jcmd <pid> GC.class_histogram` ([inspect-session](../procedures/inspect-session.md)).
- RSS small: something else on the instance. Check `ps` over SSM.

## Resolve

Stop the session and relaunch on a bigger instance, or fix what grows. It's fixed once available memory is back over 10%.

## Escalate

Escalate if a live session is close to running out and can't be stopped cleanly.

## Related

[FAILED](FAILED.md), [inspect-session](../procedures/inspect-session.md), [stop-or-kill](../procedures/stop-or-kill.md)
