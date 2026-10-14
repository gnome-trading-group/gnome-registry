---
type: CUSTOM
summary: A strategy or service raised its own alert.
first_steps:
  - Read the alert's text: the producer says what's wrong.
  - Check the session page if it names one.
  - Ask the strategy's owner if unclear.
---

## What it means

An alert a producer raised with its own text and severity (capped at ERROR so it never pages). An unknown alert type also lands here, with its original type in the labels.

## Impact

Whatever the producer says.

## Diagnose

The producer's logs ([inspect-session](../procedures/inspect-session.md) for a session).

## Resolve

Per the producer.

## Escalate

Per the producer.

## Related

[inspect-session](../procedures/inspect-session.md)
