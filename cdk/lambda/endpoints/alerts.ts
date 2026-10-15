import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { getActor, parseIdList, withTransaction } from './base';
import { sinksFor } from '../alerts/routes';
import { connectLedgerDatabase, createResponse, isSessionId, parsePositiveInt } from './ledger-common';

// The controller's view of alerts: what's open now and what fired before, newest first, and taking one in hand.
//   acknowledge  an ongoing problem (a monitoring rule's finding, a CloudWatch alarm): it stays open while the problem
//                lasts, so it can't page again, and resolves on its own once it clears
//   close        a reported event: it has nothing left to wait for, so it resolves
// Either way Slack and incident.io are told within a minute: this Lambda can't reach them from the VPC, so the
// alert is left owing them the update, and the next tick delivers it.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const STATUSES = ['PENDING', 'FIRING', 'RESOLVED'];
const SEVERITIES = ['CRITICAL', 'ERROR', 'WARNING', 'INFO'];

function list(value: string | undefined, allowed: string[]): string[] {
  return (value ?? '').split(',').map(v => v.trim().toUpperCase()).filter(v => allowed.includes(v));
}

export async function listAlerts(client: PoolClient, params: Record<string, string | undefined>) {
  const where = ['NOT (status = \'RESOLVED\' AND fire_count = 0)'];
  const args: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    args.push(value);
    where.push(sql.replace('?', `$${args.length}`));
  };
  const statuses = list(params.status, STATUSES);
  if (statuses.length > 0) add('status = ANY(?::text[])', statuses);
  const severities = list(params.severity, SEVERITIES);
  if (severities.length > 0) add('severity = ANY(?::text[])', severities);
  if (params.type) add('type = ANY(?::text[])', params.type.split(',').map(t => t.trim()));
  if (params.sessionId && isSessionId(params.sessionId)) add('session_id = ?', params.sessionId);
  const strategyIds = parseIdList(params.strategyId);
  if (strategyIds.length > 0) add('strategy_id = ANY(?::int[])', strategyIds);
  const sinceId = parsePositiveInt(params.sinceId);
  if (sinceId !== undefined && !Number.isNaN(sinceId)) add('alert_id > ?', sinceId);
  const limit = Math.min(parsePositiveInt(params.limit) || DEFAULT_LIMIT, MAX_LIMIT);
  const offset = Number(params.offset) > 0 ? Math.floor(Number(params.offset)) : 0;
  args.push(limit, offset);
  const rows = (await client.query(
    `SELECT alert_id, key, type, source, severity, status, title, body, actor, labels, links, runbook_url, strategy_id,
       session_id, listing_id, exchange_id, account_id, mode, fire_count, first_seen, last_seen, resolved_at,
       acknowledged_by, acknowledged_at, acknowledged_reason
     FROM alert.alert WHERE ${where.join(' AND ')}
     ORDER BY alert_id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows;
  return rows.map(r => ({
    alertId: Number(r.alert_id), key: r.key, type: r.type, source: r.source, severity: r.severity, status: r.status,
    title: r.title, body: r.body, actor: r.actor, labels: r.labels, links: r.links, runbookUrl: r.runbook_url,
    strategyId: r.strategy_id, sessionId: r.session_id, listingId: r.listing_id, exchangeId: r.exchange_id,
    accountId: r.account_id, mode: r.mode, fireCount: r.fire_count, firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(), resolvedAt: r.resolved_at?.toISOString() ?? null,
    acknowledgedBy: r.acknowledged_by, acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
    acknowledgedReason: r.acknowledged_reason,
  }));
}

// Owed now, and stamped as sent just over a minute ago, so the next tick's redelivery picks it up at once.
const DELIVER_NEXT_TICK_MS = 61_000;
const MAX_REASON_LENGTH = 500;

/** @return what happened to the alert, or null when there is no open alert with that id */
export async function acknowledgeAlert(
  client: PoolClient, alertId: number, actor: string, stage: string, now = new Date(), reason: string | null = null,
): Promise<'ACKNOWLEDGED' | 'CLOSED' | null> {
  const owedSince = new Date(now.getTime() - DELIVER_NEXT_TICK_MS);
  return withTransaction(client, async () => {
    const row = (await client.query(
      `SELECT * FROM alert.alert WHERE alert_id = $1 AND status IN ('PENDING', 'FIRING') FOR UPDATE`, [alertId])).rows[0];
    if (!row) return null;
    // Only where it was announced; an alert never sent anywhere has no one to tell.
    const sinks = row.notified_at ? sinksFor(row.severity, stage, row.labels) : [];
    if (row.source === 'ingest') {
      await client.query(
        `UPDATE alert.alert SET status = 'RESOLVED', resolved_at = $4, acknowledged_by = $2, acknowledged_at = $4,
           acknowledged_reason = $6,
           pending_sinks = $3, notified_at = CASE WHEN $3 = '{}'::text[] THEN notified_at ELSE $5 END
         WHERE alert_id = $1`, [alertId, actor, sinks, now, owedSince, reason]);
      return 'CLOSED';
    }
    await client.query(
      `UPDATE alert.alert SET acknowledged_by = $2, acknowledged_at = $4, acknowledged_reason = $6, pending_sinks = $3,
         notified_at = CASE WHEN $3 = '{}'::text[] THEN notified_at ELSE $5 END
       WHERE alert_id = $1`, [alertId, actor, sinks, now, owedSince, reason]);
    return 'ACKNOWLEDGED';
  });
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    if (event.httpMethod === 'GET') {
      return createResponse(200, await listAlerts(client, event.queryStringParameters ?? {}));
    }
    if (event.httpMethod === 'PATCH') {
      const body = JSON.parse(event.body ?? '{}');
      const alertId = body?.alertId;
      if (!Number.isInteger(alertId) || alertId <= 0) return createResponse(400, { message: 'alertId is required' });
      if (body.reason !== undefined && body.reason !== null && typeof body.reason !== 'string') {
        return createResponse(400, { message: 'reason must be a string' });
      }
      const reason = (body.reason as string | undefined)?.trim() || null;
      if (reason && reason.length > MAX_REASON_LENGTH) {
        return createResponse(400, { message: `reason is limited to ${MAX_REASON_LENGTH} characters` });
      }
      const outcome = await acknowledgeAlert(client, alertId, getActor(event), process.env.STAGE ?? 'dev', new Date(), reason);
      return outcome
        ? createResponse(200, { alertId, outcome })
        : createResponse(404, { message: `No open alert ${alertId}` });
    }
    return createResponse(400, { message: 'Invalid HTTP method' });
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
