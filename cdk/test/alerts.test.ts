import { isAutomaticActor, normalizeType, severityOf } from '../lambda/alerts/alert-types';
import { sinksFor } from '../lambda/alerts/routes';
import { fromAlarm } from '../lambda/alerts/alert-router';
import { escape, messageFor } from '../lambda/alerts/sinks/slack';
import { eventFor } from '../lambda/alerts/sinks/incidentio';
import { parseAlert } from '../lambda/alerts/alerts-ingest';
import { AlertEvent, Delivery } from '../lambda/alerts/model';

const base: AlertEvent = { action: 'FIRING', key: 'k', type: 'SILENT', source: 'tick', title: 't', stateAt: '2026-10-14T12:00:00Z' };

const delivery = (d: Partial<Delivery> = {}): Delivery => ({
  alertId: 7, key: 'FATAL_ERROR:s1', type: 'FATAL_ERROR', source: 'ingest', status: 'FIRING', severity: 'CRITICAL',
  title: 'Session s1 died', body: 'NullPointerException <!channel>', actor: null, mode: 'live', strategyId: 1,
  sessionId: 's1', listingId: null, exchangeId: null, accountId: null, labels: { strategy: 'arb' }, links: [],
  runbook: { summary: 'It died.', firstSteps: ['Check the venue.'], url: 'https://github.com/x/FATAL_ERROR.md' },
  firstSeen: '2026-10-14T12:00:00Z', slackTs: null, sinks: ['incidentio', 'slack'], ...d,
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

describe('sinks', () => {
  it('escapes Slack markup so nothing a strategy writes can ping the channel', () => {
    expect(escape('<!channel> a & b > c')).toBe('&lt;!channel&gt; a &amp; b &gt; c');
    const text = JSON.stringify(messageFor(delivery(), 'https://controller', false));
    expect(text).not.toContain('<!channel>');
    expect(text).toContain('Check the venue.');
    expect(text).toContain('https://controller/sessions/s1');
  });

  it('resolving drops the first steps and turns the message green', () => {
    const resolved = messageFor(delivery({ status: 'RESOLVED' }), 'https://controller', true);
    expect(resolved.attachments[0].color).toBe('#2e7d32');
    expect(JSON.stringify(resolved)).not.toContain('Check the venue.');
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
