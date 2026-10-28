import { PoolClient } from 'pg';
import { connectDatabase } from '../connections';
import { withTransaction } from '../endpoints/base';
import { Finding, runRules } from '../monitoring/rules';
import { alertType, isForTheRecord, normalizeType, runbookFor, severityOf } from './alert-types';
import { sinksFor } from './routes';
import { AlertEvent, Delivery, METRICS_NAMESPACE, Mode, RecordResult, Sink, StoreRequest } from './model';

// The alert's database side, inside the VPC with the registry's tables. The router (outside, where Slack and
// incident.io are) invokes it directly: `detect` turns the monitoring rules into events for the bus, and `record` is
// the one place an alert's state changes, for events from every source.

// One tick at a time: an overlapping one would count a debounce twice.
const DETECT_LOCK = 4_242_200;
// Several sessions going silent in the same minute points at the heartbeat path (the registry, its database, the
// network) more than at the sessions; one alert says so, and the rest go to Slack only.
export const MASS_SILENCE = 3;
// A sink still owed the latest notification this long after it went out is tried again by the next tick.
const REDELIVER_AFTER_MS = 60_000;
// A reported event is a moment, not a state: its row closes quietly after a day, and pages are resolved by people.
const EVENT_EXPIRY_MS = 24 * 3_600_000;
const SESSION_GONE = ['STOPPING', 'STOPPED'];

const stage = () => process.env.STAGE ?? 'dev';

export async function detect(client: PoolClient, now: Date): Promise<AlertEvent[]> {
  return withTransaction(client, async () => {
    const locked = (await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [DETECT_LOCK])).rows[0].locked;
    if (!locked) return [];
    const stateAt = now.toISOString();
    // One finding per key: a debounce counts ticks, and two findings that share a key in one tick would count twice.
    const findings = [...new Map((await runRules(client, now)).filter(f => f.alertable)
      .map(f => [f.key, f] as const)).values()];
    const silent = findings.filter(f => f.kind === 'SILENT');
    const events: AlertEvent[] = findings.map(f => fromFinding(f, stateAt, silent.length >= MASS_SILENCE));
    if (silent.length >= MASS_SILENCE) {
      events.push({
        action: 'FIRING', key: 'SESSIONS_SILENT_MULTIPLE', type: 'SESSIONS_SILENT_MULTIPLE', source: 'tick', stateAt,
        title: `${silent.length} sessions went silent`, mode: silent.some(f => f.mode === 'live') ? 'live' : 'paper',
        body: 'The registry is not receiving heartbeats from several sessions at once; check the registry API and database first',
        labels: { sessions: silent.map(f => f.sessionId).join(', ') },
      });
    }

    const current = new Set(events.map(e => e.key));
    const open = (await client.query(
      `SELECT key, type FROM alert.alert WHERE source = 'tick' AND status IN ('PENDING', 'FIRING')`)).rows;
    for (const row of open) {
      if (!current.has(row.key)) {
        events.push({ action: 'RESOLVED', key: row.key, type: row.type, source: 'tick', title: '', stateAt });
      }
    }

    // An alert that fired again before an older notification of the same key went out supersedes it: the new alert
    // has its own message, and a redelivery (looked up by key) would only ever find the new one, so the old row's
    // owed sinks are dropped rather than left to hold the delivery backlog up for good.
    const superseded = (await client.query(
      `UPDATE alert.alert a SET pending_sinks = '{}'
       WHERE pending_sinks <> '{}' AND EXISTS (SELECT 1 FROM alert.alert b WHERE b.key = a.key AND b.alert_id > a.alert_id)
       RETURNING alert_id, key`)).rows;
    for (const row of superseded) {
      console.log(`Dropped the owed notifications of alert ${row.alert_id} (${row.key}): a newer alert superseded it`);
    }

    const undelivered = (await client.query(
      `SELECT DISTINCT ON (key) key, type, source FROM alert.alert
       WHERE pending_sinks <> '{}' AND notified_at < $1 ORDER BY key, alert_id DESC`,
    [new Date(now.getTime() - REDELIVER_AFTER_MS)])).rows;
    for (const row of undelivered) {
      events.push({ action: 'REDELIVER', key: row.key, type: row.type, source: row.source, title: '', stateAt });
    }

    const expired = (await client.query(
      `SELECT key, type, source FROM alert.alert
       WHERE source = 'ingest' AND status = 'FIRING' AND first_seen < $1`,
    [new Date(now.getTime() - EVENT_EXPIRY_MS)])).rows;
    for (const row of expired) {
      events.push({ action: 'RESOLVED', key: row.key, type: row.type, source: row.source, title: '', stateAt, silent: true });
    }
    return events;
  });
}

function fromFinding(f: Finding, stateAt: string, massSilence: boolean): AlertEvent {
  const labels: Record<string, string> = {};
  const context: [string, unknown][] = [['strategy', f.strategyName], ['symbol', f.symbol], ['exchange', f.exchangeName],
    ['account', f.accountLabel], ['subject', f.subject], ['since', f.since]];
  for (const [name, value] of context) if (value != null) labels[name] = String(value);
  if (massSilence && f.kind === 'SILENT') labels.route = 'slack-only';
  return {
    action: 'FIRING', key: f.key, type: f.kind, source: 'tick', title: f.title, body: f.detail, actor: f.actor,
    strategyId: f.strategyId, sessionId: f.sessionId, listingId: f.listingId, exchangeId: f.exchangeId,
    accountId: f.accountId, mode: f.mode, labels, stateAt,
  };
}

export async function record(client: PoolClient, raw: AlertEvent, now: Date): Promise<RecordResult> {
  const event = normalizeType(raw);
  return withTransaction(client, async () => {
    const latest = (await client.query(
      `SELECT * FROM alert.alert WHERE key = $1 ORDER BY alert_id DESC LIMIT 1 FOR UPDATE`, [event.key])).rows[0];
    const isOpen = latest && (latest.status === 'PENDING' || latest.status === 'FIRING');

    if (event.action === 'REDELIVER') {
      if (!latest || latest.pending_sinks.length === 0) return { notify: false };
      await client.query('UPDATE alert.alert SET notified_at = $2 WHERE alert_id = $1', [latest.alert_id, now]);
      return { notify: true, delivery: toDelivery(latest, latest.pending_sinks) };
    }
    if (latest && latest.state_at > new Date(event.stateAt)) return { notify: false };

    if (event.action === 'RESOLVED') {
      if (isOpen && latest.status === 'PENDING') {
        await client.query('DELETE FROM alert.alert WHERE alert_id = $1', [latest.alert_id]);
        return { notify: false };
      }
      if (isOpen) {
        const quiet = event.silent || latest.labels.suppressed === 'true' || latest.notified_at === null;
        const sinks: Sink[] = quiet ? [] : sinksFor(latest.severity, stage(), latest.labels);
        const resolved = (await client.query(
          `UPDATE alert.alert SET status = 'RESOLVED', resolved_at = $2, state_at = $3, pending_sinks = $4,
             notified_at = CASE WHEN $4 = '{}'::text[] THEN notified_at ELSE $2 END
           WHERE alert_id = $1 RETURNING *`,
        [latest.alert_id, now, event.stateAt, sinks])).rows[0];
        return sinks.length > 0 ? { notify: true, delivery: toDelivery(resolved, sinks) } : { notify: false };
      }
      // Resolved before its alarm arrived: kept, so the late alarm is seen as old rather than new.
      if (!latest && event.source !== 'tick') {
        await insert(client, event, now, { status: 'RESOLVED', severity: 'INFO', mode: event.mode ?? null, sinks: [],
          fireCount: 0, pendingTicks: 0, suppressed: false });
      }
      return { notify: false };
    }

    const session = event.sessionId ? (await client.query(
      'SELECT mode, status FROM strategy.session WHERE session_id = $1', [event.sessionId])).rows[0] : undefined;
    const mode: Mode | null = session?.mode ?? event.mode ?? null;
    const severity = severityOf(event, mode, stage());
    const type = alertType(event.type);

    if (isOpen && latest.status === 'FIRING') {
      await client.query(
        `UPDATE alert.alert SET fire_count = fire_count + 1, last_seen = $2, state_at = $3 WHERE alert_id = $1`,
        [latest.alert_id, now, event.stateAt]);
      return { notify: false };
    }
    if (isOpen) {
      if (latest.pending_ticks + 1 < type.debounce) {
        await client.query(
          `UPDATE alert.alert SET pending_ticks = pending_ticks + 1, last_seen = $2, state_at = $3 WHERE alert_id = $1`,
          [latest.alert_id, now, event.stateAt]);
        return { notify: false };
      }
      // Acknowledged while it was still pending: it fires, but someone already has it, so nobody is paged.
      const sinks: Sink[] = latest.acknowledged_by ? [] : sinksFor(severity, stage(), latest.labels);
      const fired = (await client.query(
        `UPDATE alert.alert SET status = 'FIRING', pending_ticks = pending_ticks + 1, fire_count = 1, severity = $4,
           last_seen = $2, state_at = $3, pending_sinks = $5,
           notified_at = CASE WHEN $5 = '{}'::text[] THEN notified_at ELSE $2 END
         WHERE alert_id = $1 RETURNING *`,
      [latest.alert_id, now, event.stateAt, severity, sinks])).rows[0];
      return sinks.length > 0 ? { notify: true, delivery: toDelivery(fired, sinks) } : { notify: false };
    }

    // Something a session reports while it's being stopped is the stop itself (its agents closing, its gateways
    // disconnecting), not a problem; kept for the record, unless it's about the stop.
    const suppressed = event.source !== 'tick' && session !== undefined && SESSION_GONE.includes(session.status)
      && !type.aboutStopping;
    const pending = !suppressed && type.debounce > 1;
    const sinks = suppressed || pending ? [] : sinksFor(severity, stage(), event.labels ?? {});
    // Announced, it stays open until delivered (so a redelivery still posts it as new); with nowhere to go, it's done.
    const closed = isForTheRecord(event.source, severity) && sinks.length === 0;
    const row = await insert(client, event, now, {
      status: pending ? 'PENDING' : closed ? 'RESOLVED' : 'FIRING', severity, mode, sinks, fireCount: pending ? 0 : 1,
      pendingTicks: pending ? 1 : 0, suppressed,
    });
    // A concurrent record of the same key opened it first; that one notifies.
    if (!row) return { notify: false };
    return sinks.length > 0 ? { notify: true, delivery: toDelivery(row, sinks) } : { notify: false };
  });
}

interface InsertOptions {
  status: 'PENDING' | 'FIRING' | 'RESOLVED';
  severity: string;
  mode: Mode | null;
  sinks: Sink[];
  fireCount: number;
  pendingTicks: number;
  suppressed: boolean;
}

async function insert(client: PoolClient, event: AlertEvent, now: Date, o: InsertOptions) {
  const labels = { ...event.labels, ...(o.suppressed ? { suppressed: 'true' } : {}) };
  const runbook = runbookFor(event);
  const result = await client.query(
    `INSERT INTO alert.alert (key, type, source, severity, status, title, body, actor, labels, links, runbook_url,
       strategy_id, session_id, listing_id, exchange_id, account_id, mode, pending_ticks, fire_count, first_seen,
       last_seen, state_at, resolved_at, pending_sinks, notified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20, $21,
       CASE WHEN $5 = 'RESOLVED' THEN $20::timestamptz END, $22, CASE WHEN $22 = '{}'::text[] THEN NULL ELSE $20::timestamptz END)
     ON CONFLICT (key) WHERE status IN ('PENDING', 'FIRING') DO NOTHING
     RETURNING *`,
  [event.key, event.type, event.source, o.severity, o.status, event.title, event.body ?? null, event.actor ?? null,
    JSON.stringify(labels), JSON.stringify(event.links ?? []), runbook?.url ?? null, event.strategyId ?? null,
    event.sessionId ?? null, event.listingId ?? null, event.exchangeId ?? null, event.accountId ?? null, o.mode,
    o.pendingTicks, o.fireCount, now, event.stateAt, o.sinks]);
  return result.rows[0];
}

function toDelivery(row: any, sinks: Sink[]): Delivery {
  return {
    alertId: Number(row.alert_id), key: row.key, type: row.type, source: row.source, status: row.status,
    severity: row.severity, title: row.title, body: row.body, actor: row.actor, mode: row.mode,
    strategyId: row.strategy_id, sessionId: row.session_id, listingId: row.listing_id, exchangeId: row.exchange_id,
    accountId: row.account_id, labels: row.labels, links: row.links,
    runbook: runbookFor({ type: row.type, labels: row.labels } as AlertEvent),
    firstSeen: row.first_seen.toISOString(), slackTs: row.slack_ts, acknowledgedBy: row.acknowledged_by ?? null,
    acknowledgedReason: row.acknowledged_reason ?? null, sinks,
  };
}

export async function markDelivered(
  client: PoolClient, alertId: number, sink: Sink, slackTs: string | null, now = new Date(),
): Promise<void> {
  const row = (await client.query(
    `UPDATE alert.alert SET pending_sinks = array_remove(pending_sinks, $2), slack_ts = COALESCE($3, slack_ts)
     WHERE alert_id = $1 RETURNING source, severity, status, pending_sinks`, [alertId, sink, slackTs])).rows[0];
  // Quietly: Slack keeps the message as posted, as it did when these closed after a day.
  if (row && row.status === 'FIRING' && row.pending_sinks.length === 0 && isForTheRecord(row.source, row.severity)) {
    await client.query(
      `UPDATE alert.alert SET status = 'RESOLVED', resolved_at = $2 WHERE alert_id = $1 AND status = 'FIRING'`,
      [alertId, now]);
  }
}

// How long the oldest owed notification has waited, as a CloudWatch metric (embedded in the log line: the store has
// no route to CloudWatch's API from the VPC). A Slack or incident.io outage shows here before anyone notices.
async function logDeliveryBacklog(client: PoolClient, now: Date): Promise<void> {
  const oldest = (await client.query(
    `SELECT MIN(notified_at) AS at FROM alert.alert WHERE pending_sinks <> '{}'`)).rows[0].at as Date | null;
  const seconds = oldest ? Math.max(0, (now.getTime() - oldest.getTime()) / 1000) : 0;
  console.log(JSON.stringify({
    _aws: { Timestamp: now.getTime(), CloudWatchMetrics: [{ Namespace: METRICS_NAMESPACE, Dimensions: [[]],
      Metrics: [{ Name: 'OldestUndeliveredSeconds', Unit: 'Seconds' }] }] },
    OldestUndeliveredSeconds: seconds,
  }));
}

export const handler = async (request: StoreRequest) => {
  const pool = await connectDatabase(2);
  const client = await pool.connect();
  try {
    switch (request.op) {
      case 'detect': {
        const now = request.now ? new Date(request.now) : new Date();
        const events = await detect(client, now);
        await logDeliveryBacklog(client, now);
        return { events };
      }
      case 'record':
        return await record(client, request.event, request.now ? new Date(request.now) : new Date());
      case 'markDelivered':
        await markDelivered(client, request.alertId, request.sink, request.slackTs ?? null);
        return { ok: true };
      default:
        throw new Error(`Unknown op ${(request as { op: string }).op}`);
    }
  } finally {
    client.release();
  }
};
