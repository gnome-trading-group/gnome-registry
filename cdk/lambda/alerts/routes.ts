import { Severity, Sink } from './model';

// Where an alert goes. Every alert is posted to the stage's Slack channel; in prod a CRITICAL one also pages through
// incident.io, unless it's marked slack-only (one of many sessions going silent at once: the page is the one alert
// saying so). An INFO alert marked silent (a launcher rule set to quiet) is only recorded, for the Alerts page; the
// label can't quiet anything worse, so a mislabelled problem still reaches someone. Severity has already been capped
// for paper sessions and dev, so neither can reach incident.io.
export function sinksFor(severity: Severity, stage: string, labels: Record<string, string>): Sink[] {
  if (severity === 'INFO' && labels.route === 'silent') return [];
  if (stage === 'prod' && severity === 'CRITICAL' && labels.route !== 'slack-only') return ['incidentio', 'slack'];
  return ['slack'];
}
