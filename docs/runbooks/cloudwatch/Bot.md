---
type: Bot
summary: A gnome-bot alarm fired: the Slack ops bot may not be answering questions or triaging alerts.
first_steps:
  - Open the alarm to see which part (work queue, Slack events, worker, answers).
  - Read the worker's logs (log group `<Stage>-BotStack-WorkerLogs…`) for "Couldn't answer" and the error after it.
  - Ask the bot something in Slack to see whether it answers now.
---

## What it means

Alarms named `Bot-…`, all Warning:

| Alarm | Fires when |
|---|---|
| WorkQueue DLQ | a question or alert triage failed twice and was set aside |
| WorkQueue queue age | work waiting over 10 minutes (the worker is failing or throttled) |
| SlackEvents fault count | the Slack events endpoint is failing, so Slack may stop sending events |
| Worker fault count | the worker Lambda crashed or timed out |
| Answers AnswerFailures | the worker couldn't answer 3+ times in 5 minutes (it posted an error in the thread instead) |
| Interact fault count | a Slack button click ("Attempt fix") failed before it could start the fix run |
| GithubWebhook fault count | GitHub's PR-comment deliveries are failing, so `@gnome-bot` on PRs isn't heard (GitHub shows failed deliveries under the App's Advanced settings) |
| Notes fault count | the team notes API behind the controller's Tools → Bot Notes page is failing (the bot still answers) |
| GithubCallback fault count | a fix run's report back failed, so its thread may never get the PR link (the run itself is on the gnome-bot repo's Actions page) |

## Impact

People don't get answers in Slack and new alerts aren't triaged. Trading is unaffected: the bot only reads.

## Diagnose

The worker's logs give the cause after "Couldn't answer". Common ones:

- `missing_scope`: the Slack app lacks a scope; add it and reinstall the app.
- `not_in_channel`: the bot isn't in that channel; `/invite @Gnome Bot`.
- Out of model credit or the provider is down: the bot also raises `gnome-bot:model-unavailable` once a day; check
  the Anthropic Console workspace (gnome-bot-prod / gnome-bot-dev) balance.
- Registry, controller or launcher API errors: the bot's tools call them with its Cognito client; a 401/403 means the
  `gnome-bot/cognito-client` secret or the APIs' authorizer changed.

## Resolve

Fix the cause; nothing needs replaying. Questions that failed were already answered with an error in their thread, so
whoever asked can ask again. Purge the DLQ once the cause is fixed.

## Escalate

No.

## Related

gnome-bot's `CLAUDE.md` (Operations section).
