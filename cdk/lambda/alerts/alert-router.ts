import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { normalizeType, runbookFor, severityOf } from './alert-types';
import { sinksFor } from './routes';
import {
  ALERT_BUS_NAME, ALERT_DETAIL_TYPE, ALERT_EVENT_SOURCE, AlertEvent, Delivery, RecordResult, Severity, Sink, StoreRequest,
} from './model';
import { sendToSlack } from './sinks/slack';
import { sendToIncidentIo } from './sinks/incidentio';

// Outside the VPC, where Slack and incident.io are; the store it calls runs inside, next to the database.
//   the 1-minute rule: asks the store what the monitoring rules find, and puts it on the bus
//   an alert on the bus (from the tick, the ingest API or any service in the account): records it, then delivers
//   a CloudWatch alarm changing state: the same, once it's in the alert shape
// A sink that fails is logged, not retried here: the alert stays owed to it, and the next tick redelivers. If the
// store can't be reached, a new alert is delivered anyway (nothing must stop a page) and the invocation fails, so
// EventBridge's retry records it later.

const lambdaClient = new LambdaClient({});
const events = new EventBridgeClient({});
const secrets = new SecretsManagerClient({});
const secretCache = new Map<string, string>();

const stage = () => process.env.STAGE ?? 'dev';
const PUT_EVENTS_BATCH = 10;
const IGNORED_ALARM_PREFIXES = ['TargetTracking', 'AlertingMeta-'];
const ALARM_TIERS: Record<string, Severity> = { Critical: 'CRITICAL', Error: 'ERROR', Warning: 'WARNING' };

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

export async function handleAlert(event: AlertEvent): Promise<void> {
  let result: RecordResult;
  try {
    result = await invokeStore<RecordResult>({ op: 'record', event });
  } catch (error) {
    if (event.action === 'FIRING') await deliver(unrecorded(event));
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
    if (alert) await handleAlert(alert);
    return;
  }
  if (event.source === ALERT_EVENT_SOURCE) {
    await handleAlert(event.detail as AlertEvent);
    return;
  }
  console.warn('Ignoring an event the router does not handle', JSON.stringify(event).slice(0, 500));
};
