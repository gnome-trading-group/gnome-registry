# Runbooks

What to do when an alert fires. Every alert links here, to the runbook for its type (`alerts/<TYPE>.md`) or, for a
CloudWatch alarm, its service (`cloudwatch/<Service>.md`). They live on GitHub so they're readable when AWS, the
registry or the controller is the thing that's down.

## Severity

| Severity | Means | Goes to |
|---|---|---|
| CRITICAL | Money is at risk now | prod: incident.io pages the on-call, and `#gnome-alerts-prod` |
| ERROR | Needs a person today | `#gnome-alerts-prod` |
| WARNING | Worth a look | `#gnome-alerts-prod` |
| INFO | For the record | `#gnome-alerts-prod` |

Paper sessions and the dev stage are capped at ERROR (dev posts to `#gnome-alerts-dev`), so they never page.

## Where alerts come from

- **The monitoring rules** (`cdk/lambda/monitoring/rules`), every minute: the same findings the controller's overview
  shows. A finding that goes away resolves its alert.
- **Reported events**: a session's fatal error, the launcher, a failed pipeline run, strategies.
- **CloudWatch alarms**, named `<Service>-…-<Critical|Error|Warning>`.

A normal stop never alerts: the rules stop judging a session once it's STOPPING, and what it reports while it shuts
down is recorded but not sent.

## On call

- Pages come from incident.io. Most alerts resolve on their own once the problem is gone (the session recovers, the
  kill switch is turned off, the alarm returns to OK), and that resolves them in Slack and incident.io too.
- **Acknowledge** an alert in the controller (`/system/alerts`) to say you have it: the page stops, the Slack message
  turns grey with your name, and an ongoing problem stays open, without paging again, until it clears. For a reported
  event (a fatal error, a failed launch) the button is **Close**, which resolves it everywhere.
- Resolving a page in incident.io only stops the page; it doesn't reach the controller or Slack.
- On-call rotation and escalation: TODO(owner): name the primary and secondary, and how to reach them.
- Venue support contacts: TODO(owner).

## First moves for anything live

1. Is money at risk? Check the venue for resting orders and positions ([check-venue-orders](procedures/check-venue-orders.md)).
2. Stop the bleeding before diagnosing: a kill switch or a stop ([stop-or-kill](procedures/stop-or-kill.md)).
3. Then find out why ([inspect-session](procedures/inspect-session.md)).

## Writing a runbook

Copy `_template.md`. The front matter's `summary` and `first_steps` travel with every alert, so keep them short and
doable from a phone. After `npm run runbooks` (in `cdk/`), commit the regenerated `cdk/lambda/alerts/runbooks.generated.json`.
`npm test` fails if a type has no runbook or the generated file is stale. After each incident, update its runbook.
