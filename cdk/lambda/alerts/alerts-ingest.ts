import { APIGatewayProxyEvent } from 'aws-lambda';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { ALERT_BUS_NAME, ALERT_DETAIL_TYPE, ALERT_EVENT_SOURCE, AlertEvent, SEVERITIES, Severity } from './model';

// POST /alerts on the alerts API: how a session, the launcher, gnomepy or a strategy reports something. It only
// checks the shape and puts it on the bus, so a report is accepted even while the registry's database is down; the
// router does the rest, the same as for every other source.
//   { type, title, status?: FIRING|RESOLVED, key?, severity?, body?, actor?, strategyId?, sessionId?, listingId?,
//     exchangeId?, accountId?, mode?, labels?, links?, occurredAt? }

const events = new EventBridgeClient({});
const MAX_TITLE = 300;
const MAX_BODY = 4000;
const MAX_LABELS = 30;

class Invalid extends Error {}

function response(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function optionalInt(value: unknown, name: string): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Invalid(`${name} must be a positive integer`);
  return value as number;
}

function optionalString(value: unknown, name: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Invalid(`${name} must be a string`);
  return value.slice(0, max);
}

export function parseAlert(body: unknown, actorFromToken: string | null, now: Date): AlertEvent {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Invalid('Body must be a JSON object');
  const b = body as Record<string, unknown>;
  if (typeof b.type !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(b.type)) throw new Invalid('type must be UPPER_SNAKE_CASE');
  if (typeof b.title !== 'string' || b.title.trim() === '') throw new Invalid('title is required');
  const status = b.status ?? 'FIRING';
  if (status !== 'FIRING' && status !== 'RESOLVED') throw new Invalid('status must be FIRING or RESOLVED');
  if (b.severity != null && !SEVERITIES.includes(b.severity as Severity)) throw new Invalid(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (b.mode != null && b.mode !== 'live' && b.mode !== 'paper') throw new Invalid('mode must be live or paper');
  const labels: Record<string, string> = {};
  if (b.labels != null) {
    if (typeof b.labels !== 'object' || Array.isArray(b.labels)) throw new Invalid('labels must be an object');
    for (const [k, v] of Object.entries(b.labels as object).slice(0, MAX_LABELS)) labels[k] = String(v).slice(0, 200);
  }
  const links = Array.isArray(b.links)
    ? b.links.filter((l: any) => typeof l?.title === 'string' && typeof l?.url === 'string' && /^https:\/\//.test(l.url))
      .slice(0, 3).map((l: any) => ({ title: l.title.slice(0, 50), url: l.url }))
    : [];
  const strategyId = optionalInt(b.strategyId, 'strategyId');
  const sessionId = optionalString(b.sessionId, 'sessionId', 128);
  const title = b.title.slice(0, MAX_TITLE);
  // Without a key, one occurrence per type and target; a CUSTOM alert's title is part of what it's about.
  const key = optionalString(b.key, 'key', 200)
    ?? [b.type, sessionId ?? '-', strategyId ?? '-', ...(b.type === 'CUSTOM' ? [title] : [])].join(':');
  const occurredAt = optionalString(b.occurredAt, 'occurredAt', 40);
  if (occurredAt !== null && Number.isNaN(Date.parse(occurredAt))) throw new Invalid('occurredAt must be an ISO time');
  return {
    action: status, key, type: b.type, source: 'ingest', severity: (b.severity as Severity) ?? undefined, title,
    body: optionalString(b.body, 'body', MAX_BODY),
    // A person's identity comes only from their token, never the body.
    actor: actorFromToken ?? optionalString(b.actor, 'actor', 200),
    strategyId, sessionId, listingId: optionalInt(b.listingId, 'listingId'),
    exchangeId: optionalInt(b.exchangeId, 'exchangeId'), accountId: optionalInt(b.accountId, 'accountId'),
    mode: (b.mode as 'live' | 'paper') ?? null, labels, links, stateAt: occurredAt ?? now.toISOString(),
  };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.httpMethod !== 'POST') return response(405, { message: 'POST only' });
  let alert: AlertEvent;
  try {
    alert = parseAlert(JSON.parse(event.body ?? 'null'), event.requestContext?.authorizer?.claims?.email ?? null, new Date());
  } catch (error) {
    if (error instanceof Invalid || error instanceof SyntaxError) return response(400, { message: error.message });
    throw error;
  }
  const res = await events.send(new PutEventsCommand({
    Entries: [{ EventBusName: ALERT_BUS_NAME, Source: ALERT_EVENT_SOURCE, DetailType: ALERT_DETAIL_TYPE, Detail: JSON.stringify(alert) }],
  }));
  if (res.FailedEntryCount) return response(503, { message: 'The alert could not be queued; retry' });
  return response(202, { key: alert.key });
};
