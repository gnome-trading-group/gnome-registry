import { isAutomaticActor, normalizeType, severityOf } from '../lambda/alerts/alert-types';
import { sinksFor } from '../lambda/alerts/routes';
import { deliveredEvent, deliverUnrecorded, fromAlarm, fromCostNotification } from '../lambda/alerts/alert-router';
import { acknowledgedMessage, escape, firingMessage, resolvedMessage } from '../lambda/alerts/sinks/slack';
import { eventFor } from '../lambda/alerts/sinks/incidentio';
import { parseAlert } from '../lambda/alerts/alerts-ingest';
import { AlertEvent, Delivery } from '../lambda/alerts/model';

const base: AlertEvent = { action: 'FIRING', key: 'k', type: 'SILENT', source: 'tick', title: 't', stateAt: '2026-10-14T12:00:00Z' };

const delivery = (d: Partial<Delivery> = {}): Delivery => ({
  alertId: 7, key: 'FATAL_ERROR:s1', type: 'FATAL_ERROR', source: 'ingest', status: 'FIRING', severity: 'CRITICAL',
  title: 'Session s1 died', body: 'NullPointerException <!channel>', actor: null, mode: 'live', strategyId: 1,
  sessionId: 's1', listingId: null, exchangeId: null, accountId: null, labels: { strategy: 'arb' }, links: [],
  runbook: { summary: 'It died.', firstSteps: ['Check the venue.'], url: 'https://github.com/x/FATAL_ERROR.md' },
  firstSeen: '2026-10-14T12:00:00Z', slackTs: null, acknowledgedBy: null, acknowledgedReason: null, sinks: ['incidentio', 'slack'], ...d,
});

describe('alert severity', () => {
  it('pages for automatic kill switches only', () => {
    expect(['oms', 'session s1 startup', null, ''].map(isAutomaticActor)).toEqual([true, true, true, true]);
    expect(['ops@gnome.group', 'launcher:cs2', 'slack:mason', 'system'].map(isAutomaticActor)).toEqual([false, false, false, false]);
    expect(severityOf({ ...base, type: 'STRATEGY_HALT', actor: 'oms' }, 'live', 'prod')).toBe('CRITICAL');
    expect(severityOf({ ...base, type: 'STRATEGY_HALT', actor: 'slack:mason' }, 'live', 'prod')).toBe('INFO');
  });

  it('caps paper, dev and custom alerts below paging', () => {
    expect(severityOf(base, 'live', 'prod')).toBe('CRITICAL');
    expect(severityOf(base, 'paper', 'prod')).toBe('ERROR');
    expect(severityOf(base, 'live', 'dev')).toBe('ERROR');
    expect(severityOf({ ...base, type: 'CUSTOM', severity: 'CRITICAL' }, 'live', 'prod')).toBe('ERROR');
    expect(severityOf({ ...base, type: 'NO_PRICE' }, 'paper', 'prod')).toBe('INFO');
  });

  it('pages a failed pipeline only when it was scheduled', () => {
    expect(severityOf({ ...base, type: 'PIPELINE_FAILED', labels: { trigger: 'scheduled' } }, null, 'prod')).toBe('ERROR');
    expect(severityOf({ ...base, type: 'PIPELINE_FAILED', labels: { trigger: 'manual' } }, null, 'prod')).toBe('INFO');
    expect(severityOf({ ...base, type: 'SESSION_EXITED' }, 'live', 'prod')).toBe('INFO');
    expect(severityOf({ ...base, type: 'SESSION_EXITED', severity: 'WARNING' }, 'live', 'prod')).toBe('WARNING');
    expect(severityOf({ ...base, type: 'SESSION_EXITED', severity: 'CRITICAL' }, 'live', 'prod')).toBe('INFO');
  });

  it('keeps an unknown type as a CUSTOM warning', () => {
    expect(normalizeType({ ...base, type: 'NEW_THING', severity: 'CRITICAL' })).toMatchObject({
      type: 'CUSTOM', severity: 'WARNING', labels: { originalType: 'NEW_THING' },
    });
  });

  it('routes only prod CRITICAL to the pager, and never one marked slack-only', () => {
    expect(sinksFor('CRITICAL', 'prod', {})).toEqual(['incidentio', 'slack']);
    expect(sinksFor('CRITICAL', 'prod', { route: 'slack-only' })).toEqual(['slack']);
    expect(sinksFor('ERROR', 'prod', {})).toEqual(['slack']);
    expect(sinksFor('CRITICAL', 'dev', {})).toEqual(['slack']);
  });
});

describe('CloudWatch alarms', () => {
  const alarm = (name: string, state: string, previous: string) => ({
    source: 'aws.cloudwatch', region: 'us-east-1', time: '2026-10-14T12:00:00Z',
    resources: [`arn:aws:cloudwatch:us-east-1:1:alarm:${name}`],
    detail: { alarmName: name, state: { value: state, reason: 'Threshold crossed', timestamp: '2026-10-14T12:00:01Z' },
      previousState: { value: previous } },
  });

  it('fires on ALARM and resolves on leaving it, with the tier from its name', () => {
    expect(fromAlarm(alarm('Registry-ExchangeSync-FaultCount-Error', 'ALARM', 'OK'))).toMatchObject({
      action: 'FIRING', type: 'CLOUDWATCH_ALARM', severity: 'ERROR',
      key: 'cw:arn:aws:cloudwatch:us-east-1:1:alarm:Registry-ExchangeSync-FaultCount-Error',
      stateAt: '2026-10-14T12:00:01Z', labels: { alarmName: 'Registry-ExchangeSync-FaultCount-Error' },
    });
    expect(fromAlarm(alarm('Registry-X-Error', 'INSUFFICIENT_DATA', 'ALARM'))?.action).toBe('RESOLVED');
    expect(fromAlarm(alarm('Registry-X-Error', 'OK', 'ALARM'))?.action).toBe('RESOLVED');
    expect(fromAlarm(alarm('Registry-X-Error', 'INSUFFICIENT_DATA', 'OK'))).toBeNull();
    expect(fromAlarm(alarm('Registry-X', 'ALARM', 'OK'))?.severity).toBe('WARNING');
  });

  it('ignores autoscaling and alerting\'s own alarms', () => {
    expect(fromAlarm(alarm('TargetTracking-table-AlarmHigh', 'ALARM', 'OK'))).toBeNull();
    expect(fromAlarm(alarm('AlertingMeta-RouterErrors-Critical', 'ALARM', 'OK'))).toBeNull();
  });
});

describe('AWS spend notifications', () => {
  const sns = (message: string, timestamp = '2026-10-19T12:00:00Z') => ({
    EventSource: 'aws:sns', Sns: { MessageId: 'm1', Timestamp: timestamp, Message: message },
  });
  const budget = (alertType: string, threshold: string, amount: string) => [
    'AWS Budget Notification October 19, 2026', 'AWS Account 241533121172', '',
    'Budget Name: gnome-monthly', 'Budget Type: Cost', 'Budgeted Amount: $300.00',
    `Alert Type: ${alertType}`, `Alert Threshold: > ${threshold}`, `${alertType} Amount: ${amount}`,
  ].join('\n');

  it('warns nearing the budget or on a forecast, and errors past it', () => {
    expect(fromCostNotification(sns(budget('ACTUAL', '$240.00', '$245.12')))).toMatchObject({
      type: 'COST_BUDGET', severity: 'WARNING', key: 'budget:gnome-monthly:ACTUAL:240:2026-10',
      title: 'AWS spend $245.12 is over $240.00 on budget gnome-monthly ($300.00/month)',
    });
    expect(fromCostNotification(sns(budget('ACTUAL', '$300.00', '$1,301.50')))).toMatchObject({
      severity: 'ERROR', title: 'AWS spend $1301.50 is over $300.00 on budget gnome-monthly ($300.00/month)',
    });
    expect(fromCostNotification(sns(budget('FORECASTED', '$300.00', '$320.00')))).toMatchObject({
      severity: 'WARNING', key: 'budget:gnome-monthly:FORECASTED:300:2026-10',
    });
  });

  it('keys a budget threshold per month, so next month\'s crossing is new', () => {
    const october = fromCostNotification(sns(budget('ACTUAL', '$240.00', '$245.12')))!;
    const november = fromCostNotification(sns(budget('ACTUAL', '$240.00', '$245.12'), '2026-11-20T12:00:00Z'))!;
    expect(october.key).not.toBe(november.key);
  });

  it('reads a spend anomaly', () => {
    const anomaly = JSON.stringify({
      anomalyId: 'an-1', monitorName: 'gnome-services', dimensionalValue: 'Amazon Elastic Compute Cloud - Compute',
      impact: { totalImpact: 84.5 }, anomalyDetailsLink: 'https://console.aws.amazon.com/cost-management/home#/anomaly-detection/an-1',
      rootCauses: [{ service: 'Amazon Elastic Compute Cloud - Compute', region: 'eu-west-1', usageType: 'BoxUsage:c7i.4xlarge' }],
    });
    expect(fromCostNotification(sns(anomaly))).toMatchObject({
      type: 'COST_ANOMALY', key: 'cost-anomaly:an-1',
      title: 'AWS spend anomaly: $84.50 over expected (Amazon Elastic Compute Cloud - Compute)',
      body: 'Root causes:\nAmazon Elastic Compute Cloud - Compute / eu-west-1 / BoxUsage:c7i.4xlarge',
    });
    expect(severityOf(fromCostNotification(sns(anomaly))!, null, 'prod')).toBe('ERROR');
  });
});

describe('sinks', () => {
  const target = { controllerUrl: 'https://controller', stage: 'prod' };

  it('escapes Slack markup so nothing a strategy writes can ping the channel', () => {
    expect(escape('<!channel> a & b > c')).toBe('&lt;!channel&gt; a &amp; b &gt; c');
    expect(JSON.stringify(firingMessage(delivery(), target))).not.toContain('<!channel>');
  });

  it('lays an alert out like a CloudWatch alarm: bar, header, reason, fields, next step, runbook', () => {
    const message = firingMessage(delivery(), target);
    const [attachment] = message.attachments;
    const blocks = attachment.blocks as any[];
    expect(attachment.color).toBe('#E01E5A');
    expect(blocks[0].text.text).toBe(':rotating_light:  *Critical*  ·  *Session s1 died*');
    expect(blocks[1].text.text).toBe('> NullPointerException &lt;!channel&gt;');
    expect(blocks[2].fields.map((f: any) => f.text)).toEqual(['*Strategy*\narb', '*Mode*\nlive', '*Session*\ns1']);
    expect(blocks[3].text.text).toBe(':point_right:  Check the venue.');
    expect(blocks[4].elements.map((b: any) => [b.text.text, b.style])).toEqual([
      [':book:  Runbook', 'primary'], ['Session', undefined], ['All alerts', undefined],
    ]);
    expect(blocks[5].elements[0].text).toBe('gnome alerts  ·  prod  ·  first seen 12:00 UTC');
  });

  it('keeps a stack trace\'s lines in a code block', () => {
    const blocks = firingMessage(delivery({ body: 'Boom\n    at A.b(A.java:1)' }), target).attachments[0].blocks as any[];
    expect(blocks[1].text.text).toBe('```Boom\n    at A.b(A.java:1)```');
  });

  it('colours each severity from Slack\'s palette, errors a deeper red than critical', () => {
    expect(firingMessage(delivery({ severity: 'ERROR' }), target).attachments[0].color).toBe('#A4262C');
    expect(firingMessage(delivery({ severity: 'WARNING' }), target).attachments[0].color).toBe('#ECB22E');
    expect(firingMessage(delivery({ severity: 'INFO' }), target).attachments[0].color).toBe('#36C5F0');
  });

  it('resolving turns the message green and short', () => {
    const resolved = resolvedMessage(delivery({ status: 'RESOLVED' }), target, new Date('2026-10-14T12:03:00Z'));
    const blocks = resolved.attachments[0].blocks as any[];
    expect(resolved.attachments[0].color).toBe('#2EB67D');
    expect(blocks[0].text.text).toBe(':white_check_mark:  *Resolved*  ·  Session s1 died');
    expect(blocks[1].elements[0].text).toBe('Critical  ·  after 3m  ·  gnome alerts  ·  prod');
  });

  it('an acknowledged alert turns grey in Slack and stops the page', () => {
    const acked = delivery({ acknowledgedBy: 'mason@gnome.group', acknowledgedReason: 'venue maintenance <until 3pm>' });
    const message = acknowledgedMessage(acked, target, new Date('2026-10-14T12:10:00Z'));
    expect(message.attachments[0].color).toBe('#9EA0A6');
    expect((message.attachments[0].blocks as any[])[2].elements[0].text)
      .toBe('by mason@gnome.group  ·  Critical  ·  open 10m  ·  resolves when it clears  ·  prod');
    expect((message.attachments[0].blocks as any[])[1].text.text).toBe('> venue maintenance &lt;until 3pm&gt;');
    expect(eventFor(acked, 'https://controller').status).toBe('resolved');
  });

  it('sends incident.io the key it deduplicates on and the runbook', () => {
    const event = eventFor(delivery(), 'https://controller');
    expect(event).toMatchObject({ deduplication_key: 'FATAL_ERROR:s1', status: 'firing', title: 'Session s1 died',
      source_url: 'https://controller/sessions/s1' });
    expect(event.metadata).toMatchObject({ severity: 'CRITICAL', session_id: 's1', strategy: 'arb', runbook_url: 'https://github.com/x/FATAL_ERROR.md' });
    expect(event.description).toContain('1. Check the venue.');
    expect(eventFor(delivery({ status: 'RESOLVED' }), 'https://controller').status).toBe('resolved');
  });
});

describe('the ingest API', () => {
  const now = new Date('2026-10-14T12:00:00Z');

  it('accepts a report and keys it by type and target', () => {
    expect(parseAlert({ type: 'FATAL_ERROR', title: 'died', sessionId: 's1', strategyId: 3, mode: 'live' }, null, now))
      .toMatchObject({ action: 'FIRING', key: 'FATAL_ERROR:s1:3', source: 'ingest', stateAt: now.toISOString() });
    expect(parseAlert({ type: 'CUSTOM', title: 'fair value', strategyId: 3 }, null, now).key).toBe('CUSTOM:-:3:fair value');
    expect(parseAlert({ type: 'PIPELINE_FAILED', title: 'x', key: 'pipeline:a:1', status: 'RESOLVED' }, null, now))
      .toMatchObject({ key: 'pipeline:a:1', action: 'RESOLVED' });
  });

  it('takes a person\'s identity from their token, never the body', () => {
    expect(parseAlert({ type: 'CUSTOM', title: 'x', actor: 'someone' }, 'me@gnome.group', now).actor).toBe('me@gnome.group');
    expect(parseAlert({ type: 'CUSTOM', title: 'x', actor: 'launcher:cs2' }, null, now).actor).toBe('launcher:cs2');
  });

  it('refuses malformed reports', () => {
    for (const bad of [null, [], { title: 'x' }, { type: 'lower', title: 'x' }, { type: 'X', title: '' },
      { type: 'X', title: 'x', status: 'OPEN' }, { type: 'X', title: 'x', severity: 'HIGH' },
      { type: 'X', title: 'x', mode: 'demo' }, { type: 'X', title: 'x', strategyId: -1 },
      { type: 'X', title: 'x', occurredAt: 'yesterday' }]) {
      expect(() => parseAlert(bad, null, now)).toThrow();
    }
  });
});

describe('an alert the store could not record', () => {
  const sent = '2026-10-15T11:29:10Z';
  const at = (seconds: number) => new Date(new Date(sent).getTime() + seconds * 1000);

  it('is delivered on its first attempt only, not again on each retry', () => {
    expect(deliverUnrecorded('evt-1', sent, at(2))).toBe(true);
    expect(deliverUnrecorded('evt-1', sent, at(65))).toBe(false);
    expect(deliverUnrecorded('evt-1', sent, at(180))).toBe(false);
  });

  it('is delivered when its age is unknown, rather than risk dropping it', () => {
    expect(deliverUnrecorded(undefined, undefined, at(300))).toBe(true);
  });
});

describe('announcing a delivered alert for triage', () => {
  it('announces a firing post with where it is, what it is about and its runbook', () => {
    const event = deliveredEvent(delivery(), 'C1', '100.1', 'prod')!;
    expect(event).toMatchObject({
      alertId: 7, type: 'FATAL_ERROR', severity: 'CRITICAL', sessionId: 's1', strategyId: 1, mode: 'live',
      slackChannel: 'C1', slackTs: '100.1', firstPost: true, stage: 'prod',
      runbook: { url: 'https://github.com/x/FATAL_ERROR.md' },
    });
  });

  it('marks a repeat fire, which gets a new message, as not the first post', () => {
    expect(deliveredEvent(delivery({ slackTs: '90.0' }), 'C1', '100.1', 'prod')!.firstPost).toBe(false);
  });

  it.each([
    ['a resolve', delivery({ status: 'RESOLVED', slackTs: '90.0' })],
    ['an acknowledged alert', delivery({ acknowledgedBy: 'mason@gnome.group', slackTs: '90.0' })],
  ])('does not announce %s, which only edits the existing message', (_name, d) => {
    expect(deliveredEvent(d, 'C1', '90.0', 'prod')).toBeNull();
  });

  it('does not announce when Slack returned no message', () => {
    expect(deliveredEvent(delivery(), 'C1', null, 'prod')).toBeNull();
  });

  it('caps the body it passes on', () => {
    expect(deliveredEvent(delivery({ body: 'x'.repeat(10_000) }), 'C1', '1.1', 'prod')!.body).toHaveLength(4000);
  });
});
