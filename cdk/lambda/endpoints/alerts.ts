import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { getActor, parseIdList } from './base';
import { connectLedgerDatabase, createResponse, isSessionId, parsePositiveInt } from './ledger-common';

// The controller's view of alerts: what's open now and what fired before, newest first. Closing one here only ends
// its row; a page is acknowledged and resolved in incident.io, and an alert whose problem persists opens again.

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
       session_id, listing_id, exchange_id, account_id, mode, fire_count, first_seen, last_seen, resolved_at
     FROM alert.alert WHERE ${where.join(' AND ')}
     ORDER BY alert_id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args)).rows;
  return rows.map(r => ({
    alertId: Number(r.alert_id), key: r.key, type: r.type, source: r.source, severity: r.severity, status: r.status,
    title: r.title, body: r.body, actor: r.actor, labels: r.labels, links: r.links, runbookUrl: r.runbook_url,
    strategyId: r.strategy_id, sessionId: r.session_id, listingId: r.listing_id, exchangeId: r.exchange_id,
    accountId: r.account_id, mode: r.mode, fireCount: r.fire_count, firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(), resolvedAt: r.resolved_at?.toISOString() ?? null,
  }));
}

/** @return false when there is no open alert with that id */
export async function closeAlert(client: PoolClient, alertId: number, actor: string): Promise<boolean> {
  const closed = await client.query(
    `UPDATE alert.alert SET status = 'RESOLVED', resolved_at = NOW(), pending_sinks = '{}',
       labels = labels || jsonb_build_object('closedBy', $2::text)
     WHERE alert_id = $1 AND status IN ('PENDING', 'FIRING')`, [alertId, actor]);
  return closed.rowCount === 1;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    if (event.httpMethod === 'GET') {
      return createResponse(200, await listAlerts(client, event.queryStringParameters ?? {}));
    }
    if (event.httpMethod === 'PATCH') {
      const alertId = JSON.parse(event.body ?? '{}')?.alertId;
      if (!Number.isInteger(alertId) || alertId <= 0) return createResponse(400, { message: 'alertId is required' });
      return await closeAlert(client, alertId, getActor(event))
        ? createResponse(200, { alertId, status: 'RESOLVED' })
        : createResponse(404, { message: `No open alert ${alertId}` });
    }
    return createResponse(400, { message: 'Invalid HTTP method' });
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
