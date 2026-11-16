---
type: PAPER_GATEWAY_FULL
summary: A paper order gateway is refusing new paper sessions because it holds as many books or distinct streams as its caps allow.
first_steps:
  - Read the label `load` for the books and streams it holds against its caps.
  - Check the venue's other paper gateways (controller, Gateways page) for one with room.
---

## What it means

Each paper gateway takes at most `gateway.paper.max.books` books (a session's listing each, which hold its heap) and `gateway.paper.max.streams` distinct streams (which its shard reader reads every pass). A new paper session that would take it past either is refused with `SESSION_CAP` before its books are built, so the gateway never runs out of memory and drops the sessions it holds. Sessions already linked are never refused.

## Impact

The refused session can't trade until it links somewhere. It keeps saying hello; each time it asks `/gateways/paper-instance` which gateway to use, which moves it to an instance with room, starting a new one if needed. It stays refused only while every instance up to `MAX_PAPER_INSTANCES` is full, or while the session runs a release that doesn't ask.

## Diagnose

- The gateway's log line `Gateway full: no room for paper session ...` names the session and the load.
- The Gateways page: each paper gateway's books and streams against its caps, and how many instances the venue runs.
- Whether one session is unusually large (many listings) or many sessions launched at once.

## Resolve

- Usually nothing: the session moves to another instance at its next hello.
- If every instance is full, end idle paper sessions or raise `MAX_PAPER_INSTANCES` on the registry's paper-instance Lambda (and the orchestrator's paper host limit).
- Raise the caps only with a new capacity measurement for the host size.

## Escalate

No.

## Related

[PAPER_GATEWAY_OVERLOADED](PAPER_GATEWAY_OVERLOADED.md)
