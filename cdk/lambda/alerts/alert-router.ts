import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { normalizeType, runbookFor, severityOf } from './alert-types';
import { sinksFor } from './routes';
import {
  ALERT_BUS_NAME, ALERT_DELIVERED_DETAIL_TYPE, ALERT_DELIVERED_SOURCE, ALERT_DETAIL_TYPE, ALERT_EVENT_SOURCE, AlertDelivered,
  AlertEvent, Delivery, RecordResult, Severity, Sink, StoreRequest,
} from './model';
import { sendToSlack } from './sinks/slack';
import { sendToIncidentIo } from './sinks/incidentio';

// Outside the VPC, where Slack and incident.io are; the store it calls runs inside, next to the database.
//   the 1-minute rule: asks the store what the monitoring rules find, and puts it on the bus
//   an alert on the bus (from the tick, the ingest API or any service in the account): records it, then delivers
//   a CloudWatch alarm changing state: the same, once it's in the alert shape
//   a budget or spend anomaly notification (SNS): the same
// A sink that fails is logged, not retried here: the alert stays owed to it, and the next tick redelivers. If the
// store can't be reached, a new alert is delivered anyway (nothing must stop a page) and the invocation fails, so
// Lambda's retry records it later. Only the first attempt delivers it unrecorded: each retry would post it again.

const lambdaClient = new LambdaClient({});
const events = new EventBridgeClient({});
const secrets = new SecretsManagerClient({});
const secretCache = new Map<string, string>();

const stage = () => process.env.STAGE ?? 'dev';
const PUT_EVENTS_BATCH = 10;
const IGNORED_ALARM_PREFIXES = ['TargetTracking', 'AlertingMeta-'];
const ALARM_TIERS: Record<string, Severity> = { Critical: 'CRITICAL', Error: 'ERROR', Warning: 'WARNING' };
// Lambda first retries a failed event a minute after it; anything younger is still its first attempt.
const FIRST_ATTEMPT_MS = 50_000;
// Events this container already delivered unrecorded, in case a retry lands here sooner than expected.
const deliveredUnrecorded = new Set<string>();

async function secret(name: string): Promise<string> {
  if (!secretCache.has(name)) {
    const res = await secrets.send(new GetSecretValueCommand({ SecretId: name }));
    secretCache.set(name, res.SecretString!);
  }
  return secretCache.get(name)!;
}

async function invokeStore<T>(request: StoreRequest): Promise<T> {
  const res = await lambdaClient.send(new InvokeCommand({
    FunctionName: process.env.STORE_FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify(request)),
  }));
  const payload = res.Payload ? JSON.parse(Buffer.from(res.Payload).toString()) : null;
  if (res.FunctionError) throw new Error(`Alert store failed: ${JSON.stringify(payload)}`);
  return payload as T;
}

export async function putOnBus(alerts: AlertEvent[]): Promise<void> {
  for (let i = 0; i < alerts.length; i += PUT_EVENTS_BATCH) {
    const batch = alerts.slice(i, i + PUT_EVENTS_BATCH);
    const res = await events.send(new PutEventsCommand({
      Entries: batch.map(a => ({
        EventBusName: ALERT_BUS_NAME, Source: ALERT_EVENT_SOURCE, DetailType: ALERT_DETAIL_TYPE, Detail: JSON.stringify(a),
      })),
    }));
    if (res.FailedEntryCount) throw new Error(`${res.FailedEntryCount} alert events weren't put on the bus`);
  }
}

// An alarm's state change, as the alert it stands for. Only transitions into or out of ALARM matter; a resolve is
// leaving ALARM for OK or for missing data (an alarm that can't tell any more isn't saying anything is wrong).
export function fromAlarm(event: any): AlertEvent | null {
  const detail = event.detail ?? {};
  const name: string = detail.alarmName ?? '';
  if (IGNORED_ALARM_PREFIXES.some(p => name.startsWith(p))) return null;
  const state = detail.state?.value;
  const previous = detail.previousState?.value;
  const action = state === 'ALARM' ? 'FIRING' : previous === 'ALARM' ? 'RESOLVED' : null;
  if (!action) return null;
  const tier = name.slice(name.lastIndexOf('-') + 1);
  const region = event.region ?? 'us-east-1';
  return {
    action, key: `cw:${event.resources?.[0] ?? name}`, type: 'CLOUDWATCH_ALARM', source: 'cloudwatch',
    severity: ALARM_TIERS[tier] ?? 'WARNING', title: name, body: detail.state?.reason ?? null,
    labels: { alarmName: name, region },
    links: [{ title: 'Alarm', url: `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}#alarmsV2:alarm/${encodeURIComponent(name)}` }],
    stateAt: detail.state?.timestamp ?? event.time ?? new Date().toISOString(),
  };
}

const money = (text: string, label: string): number | null => {
  const match = new RegExp(`^${label}:\\s*>?\\s*\\$([\\d,.]+)`, 'm').exec(text);
  return match ? Number(match[1].replace(/,/g, '')) : null;
};

// An SNS message from AWS Budgets (plain text) or Cost Anomaly Detection (JSON). Going over the budget is ERROR;
// nearing it, or being forecast to pass it, is a WARNING. Like the ingest API's reports these are moments rather than
// states: each closes quietly after a day, and repeats of an open one only count against it.
export function fromCostNotification(record: any): AlertEvent | null {
  const sns = record?.Sns;
  if (!sns?.Message) return null;
  const stateAt: string = sns.Timestamp ?? new Date().toISOString();
  let anomaly: any = null;
  try {
    anomaly = JSON.parse(sns.Message);
  } catch {
    // Budgets' notifications aren't JSON.
  }
  if (anomaly?.anomalyId) {
    const impact = Number(anomaly.impact?.totalImpact ?? 0);
    const causes = (anomaly.rootCauses ?? []).map((c: any) => [c.service, c.region, c.usageType].filter(Boolean).join(' / '));
    return {
      action: 'FIRING', key: `cost-anomaly:${anomaly.anomalyId}`, type: 'COST_ANOMALY', source: 'ingest',
      title: `AWS spend anomaly: $${impact.toFixed(2)} over expected${anomaly.dimensionalValue ? ` (${anomaly.dimensionalValue})` : ''}`,
      body: causes.length > 0 ? `Root causes:\n${causes.join('\n')}` : null,
      labels: { monitor: String(anomaly.monitorName ?? ''), impactUsd: impact.toFixed(2) },
      links: anomaly.anomalyDetailsLink ? [{ title: 'Anomaly', url: anomaly.anomalyDetailsLink }] : [],
      stateAt,
    };
  }
  const message: string = sns.Message;
  const name = /^Budget Name:\s*(.+)$/m.exec(message)?.[1]?.trim() ?? 'budget';
  const alertType = /^Alert Type:\s*(\w+)/m.exec(message)?.[1] ?? 'ACTUAL';
  const budgeted = money(message, 'Budgeted Amount');
  const threshold = money(message, 'Alert Threshold');
  const amount = money(message, `${alertType} Amount`);
  const over = alertType === 'ACTUAL' && budgeted !== null && threshold !== null && threshold >= budgeted;
  const month = stateAt.slice(0, 7);
  return {
    action: 'FIRING', key: `budget:${name}:${alertType}:${threshold ?? '-'}:${month}`, type: 'COST_BUDGET',
    source: 'ingest', severity: over ? 'ERROR' : 'WARNING',
    title: `${alertType === 'FORECASTED' ? 'Forecast AWS spend' : 'AWS spend'} ${amount !== null ? `$${amount.toFixed(2)} ` : ''}`
      + `is over ${threshold !== null ? `$${threshold.toFixed(2)}` : 'its threshold'} on budget ${name}`
      + (budgeted !== null ? ` ($${budgeted.toFixed(2)}/month)` : ''),
    body: message.trim().slice(0, 4000),
    labels: { budget: name, alertType },
    links: [{ title: 'Budgets', url: 'https://us-east-1.console.aws.amazon.com/billing/home#/budgets' }],
    stateAt,
  };
}

// Slack caps a message at 40,000 characters; the bot needs the gist, and can look the rest up.
const DELIVERED_BODY_CHARS = 4000;

/** What gnome-bot hears when a firing alert is posted, or null for a post it shouldn't triage (an update). */
export function deliveredEvent(d: Delivery, slackChannel: string, slackTs: string | null, stageName: string): AlertDelivered | null {
  if (!slackTs || d.status !== 'FIRING' || d.acknowledgedBy) return null;
  return {
    alertId: d.alertId, key: d.key, type: d.type, severity: d.severity, title: d.title,
    body: d.body ? d.body.slice(0, DELIVERED_BODY_CHARS) : null, mode: d.mode, strategyId: d.strategyId,
    sessionId: d.sessionId, listingId: d.listingId, exchangeId: d.exchangeId, accountId: d.accountId, labels: d.labels,
    runbook: d.runbook, slackChannel, slackTs, firstPost: !d.slackTs, stage: stageName,
  };
}

// Triage is a nicety: an alert is delivered whether or not the announcement makes it.
async function announceDelivered(event: AlertDelivered): Promise<void> {
  try {
    const res = await events.send(new PutEventsCommand({
      Entries: [{
        EventBusName: ALERT_BUS_NAME, Source: ALERT_DELIVERED_SOURCE, DetailType: ALERT_DELIVERED_DETAIL_TYPE,
        Detail: JSON.stringify(event),
      }],
    }));
    if (res.FailedEntryCount) console.warn(`Announcing ${event.key} as delivered failed`, JSON.stringify(res.Entries));
  } catch (error) {
    console.warn(`Announcing ${event.key} as delivered failed`, error);
  }
}

async function deliver(d: Delivery): Promise<void> {
  const controllerUrl = process.env.CONTROLLER_URL ?? '';
  for (const sink of d.sinks) {
    try {
      let slackTs: string | null = null;
      if (sink === 'slack') {
        slackTs = await sendToSlack(d, {
          token: await secret(process.env.SLACK_BOT_TOKEN_SECRET!), channel: process.env.SLACK_CHANNEL!, controllerUrl,
          stage: stage(),
        });
      } else {
        const { alertSourceConfigId, token } = JSON.parse(await secret(process.env.INCIDENT_IO_SECRET!));
        await sendToIncidentIo(d, { alertSourceConfigId, token, controllerUrl });
      }
      if (d.alertId !== null) await invokeStore({ op: 'markDelivered', alertId: d.alertId, sink, slackTs });
      const delivered = sink === 'slack' ? deliveredEvent(d, process.env.SLACK_CHANNEL!, slackTs, stage()) : null;
      if (delivered) await announceDelivered(delivered);
    } catch (error) {
      console.error(`Delivering ${d.key} to ${sink} failed; the next tick retries it`, error);
    }
  }
}

// What the store would have sent, worked out without it: the session's mode is unknown, so the event's own is used.
function unrecorded(event: AlertEvent): Delivery {
  const normalized = normalizeType(event);
  const severity = severityOf(normalized, normalized.mode ?? null, stage());
  const labels = normalized.labels ?? {};
  const sinks: Sink[] = sinksFor(severity, stage(), labels);
  return {
    alertId: null, key: normalized.key, type: normalized.type, source: normalized.source, status: 'FIRING', severity,
    title: normalized.title, body: normalized.body ?? null, actor: normalized.actor ?? null, mode: normalized.mode ?? null,
    strategyId: normalized.strategyId ?? null, sessionId: normalized.sessionId ?? null,
    listingId: normalized.listingId ?? null, exchangeId: normalized.exchangeId ?? null,
    accountId: normalized.accountId ?? null, labels, links: normalized.links ?? [], runbook: runbookFor(normalized),
    firstSeen: normalized.stateAt, slackTs: null, acknowledgedBy: null, acknowledgedReason: null, sinks, unpersisted: true,
  };
}

/**
 * Whether to deliver an event the store couldn't record: only on its first attempt, judged by its age, so Lambda's
 * retries don't repost it. A first attempt that itself ran over a minute late is left to the DLQ alarm, which pages.
 */
export function deliverUnrecorded(eventId: string | undefined, eventTime: string | undefined, now: Date): boolean {
  if (eventId && deliveredUnrecorded.has(eventId)) return false;
  if (!eventTime) return true;
  return now.getTime() - new Date(eventTime).getTime() < FIRST_ATTEMPT_MS;
}

export async function handleAlert(event: AlertEvent, envelope: { id?: string; time?: string } = {}): Promise<void> {
  let result: RecordResult;
  try {
    result = await invokeStore<RecordResult>({ op: 'record', event });
  } catch (error) {
    if (event.action === 'FIRING' && deliverUnrecorded(envelope.id, envelope.time, new Date())) {
      if (envelope.id) deliveredUnrecorded.add(envelope.id);
      await deliver(unrecorded(event));
    }
    throw error;
  }
  if (result.notify) await deliver(result.delivery);
}

export const handler = async (event: any) => {
  if (event.source === 'aws.events' || event.tick) {
    const { events: detected } = await invokeStore<{ events: AlertEvent[] }>({ op: 'detect' });
    await putOnBus(detected);
    return;
  }
  if (event.source === 'aws.cloudwatch') {
    const alert = fromAlarm(event);
    if (alert) await handleAlert(alert, event);
    return;
  }
  if (event.source === ALERT_EVENT_SOURCE) {
    await handleAlert(event.detail as AlertEvent, event);
    return;
  }
  if (event.Records?.[0]?.EventSource === 'aws:sns') {
    for (const record of event.Records) {
      const alert = fromCostNotification(record);
      if (alert) await handleAlert(alert, { id: record.Sns.MessageId, time: record.Sns.Timestamp });
    }
    return;
  }
  console.warn('Ignoring an event the router does not handle', JSON.stringify(event).slice(0, 500));
};
