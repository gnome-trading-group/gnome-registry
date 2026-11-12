---
type: SOURCE_DEGRADED
summary: A polling source is running but one of its checks is failing (a feed, a page, a paid service or its budget).
first_steps:
  - Read the alert's body for the failing task (label `check`) and its last error.
  - Open the source's run on the controller's Research → Pipelines page and read its logs.
  - Check poll_health for the source's task_error and note rows around the alert's time.
---

## What it means

A gnome-pipelines polling source (label `pipeline`, e.g. `rt_reviews`) is still running, but something it depends on has failed long enough to matter. The source raises it itself (`gnome_pipelines/polling/alerts.py`) and resolves it once the check passes again, so an open alert means the problem is still there. The label `check` names what:

- a task (`variety.fast`, `nyt.archive`, `films`, `tomatometer`): it has gone its limit without a success (a news feed 15 min, an archive sitemap an hour, film discovery 30 min, the Tomatometer 20 min);
- `<outlet>.pages`: review pages of that outlet still unread after 4 tries (they keep being retried while their film is open);
- `claude`: Claude has been unavailable for 15 min; reviews are kept without a verdict until it answers;
- `zenrows_budget`: 80% of the day's ZenRows credits spent (WARNING), or all of them (ERROR).

## Impact

Whatever reads the source sees less, or later: for `rt_reviews`, reviews from a failing outlet are found late or not at all, a film not discovered isn't watched, and without Claude reviews have no fresh/rotten verdict. Nothing trades on a source yet, so a source never pages.

## Diagnose

- The run's logs (Pipelines page, or `/gnome-pipelines/runs` in CloudWatch).
- `poll_health` for the source: `task_error` rows give each failure; `note` rows give what the source decided (a page given up, Claude off).
- `fetched_pages`: the status and route (`via`: plain, zenrows, zenrows_premium) of each fetch of the failing host. A run of 403s on plain followed by ZenRows means the site started blocking; ZenRows failing too means it blocks proxies as well.

## Resolve

- A site blocking us: the fetcher steps up to ZenRows by itself; if even premium is refused it backs off and tries again hourly. If a site has changed its URLs, fix the outlet in `gnome_pipelines/rt/outlets.py`.
- Claude: check Anthropic's status and the `gnome/pipelines/anthropic` secret; verdicts follow once it answers.
- ZenRows budget: see which host spent it (`fetched_pages` by `via`); raise `zenrows_daily_credits` on the Pipelines page only if the spend is expected.
- The alert resolves on its own once the check passes; resolving it by hand while the cause remains just raises it again.

## Escalate

No. It's ERROR at most; raise it with whoever owns the source if it lasts into a window the source must not miss.

## Related

[PIPELINE_FAILED](PIPELINE_FAILED.md) (the source stopped altogether), [Pipelines](../cloudwatch/Pipelines.md)
