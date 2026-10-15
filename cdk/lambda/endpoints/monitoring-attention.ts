import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, parseMode } from './ledger-common';
import { DisplaySeverity, Finding, runRules } from '../monitoring/rules';

// Everything about trading in one mode that someone should look at, most serious first, for the controller's
// overview. Each item names what it concerns so the page can link to it. The findings come from the monitoring rules,
// which the alert tick also pages on (lambda/monitoring/rules).
//   critical  trading is halted everywhere or on an exchange, a running session has gone silent, its ledger is
//             failing or its risk checks can't be trusted
//   warning   a strategy or listing is halted, a position needs review, a session failed or is stuck starting or
//             stopping, a part of a running session is stalled or reconnecting, or a position on a finished market
//             hasn't been settled
//   info      a held position has had no price for a while (prediction markets can be quiet; worth knowing)
// In live mode the venue accounts too: a balance or position that disagrees with the ledger (critical), one that
// can't be read, runs low (in total or on a Kalshi shard) or is over-allocated (warning), and accounts due to be
// rotated or ready to retire (info).
// After the findings, every open alert something reported rather than a rule found (a failed pipeline or launch, a
// session's fatal error, a CloudWatch alarm), in the mode it's about or both when it's about neither. Rule alerts are
// left to their findings, which are current where an alert can lag a tick behind, and INFO alerts are for the record.

const ORDER: Record<DisplaySeverity, number> = { critical: 0, warning: 1, info: 2 };
const ALERT_SEVERITY: Record<string, DisplaySeverity> = { CRITICAL: 'critical', ERROR: 'warning', WARNING: 'warning' };

export interface AttentionItem {
  // A monitoring rule's finding, or an alert something reported.
  source: 'finding' | 'alert';
  // The open alert it's raised, if any.
  alertId: number | null;
  severity: DisplaySeverity;
  kind: string;
  title: string;
  detail: string | null;
  strategyId: number | null;
  strategyName: string | null;
  sessionId: string | null;
  listingId: number | null;
  symbol: string | null;
  exchangeId: number | null;
  exchangeName: string | null;
  accountId: number | null;
  accountLabel: string | null;
  // Who last turned a kill switch on (halts only), and the agent, gateway or account a session item is about.
  actor: string | null;
  subject: string | null;
  since: string | null;
  // Someone has taken its alert (the alert's key is the finding's): still a problem, but not unowned.
  acknowledgedBy: string | null;
  acknowledgedReason: string | null;
}

interface OpenAlert { alertId: number; by: string | null; reason: string | null }

function toItem(f: Finding, open: Map<string, OpenAlert>): AttentionItem {
  return {
    source: 'finding', alertId: open.get(f.key)?.alertId ?? null, severity: f.severity, kind: f.kind, title: f.title, detail: f.detail, strategyId: f.strategyId,
    strategyName: f.strategyName, sessionId: f.sessionId, listingId: f.listingId, symbol: f.symbol,
    exchangeId: f.exchangeId, exchangeName: f.exchangeName, accountId: f.accountId, accountLabel: f.accountLabel,
    actor: f.actor, subject: f.subject, since: f.since, acknowledgedBy: open.get(f.key)?.by ?? null,
    acknowledgedReason: open.get(f.key)?.reason ?? null,
  };
}

async function reportedAlerts(client: PoolClient, mode: 'live' | 'paper'): Promise<AttentionItem[]> {
  const rows = (await client.query(
    `SELECT a.alert_id, a.type, a.severity, a.title, a.body, a.actor, a.labels,
       COALESCE(a.strategy_id, ss.strategy_id) AS strategy_id, a.session_id,
       a.listing_id, a.exchange_id, a.account_id, a.first_seen, a.acknowledged_by, a.acknowledged_reason,
       s.name AS strategy_name, e.exchange_name
     FROM alert.alert a
     LEFT JOIN strategy.session ss ON ss.session_id = a.session_id
     LEFT JOIN strategy.strategy s ON s.strategy_id = COALESCE(a.strategy_id, ss.strategy_id)
     LEFT JOIN sm.exchange e ON e.exchange_id = a.exchange_id
     WHERE a.status IN ('PENDING', 'FIRING') AND a.source <> 'tick' AND a.severity <> 'INFO'
       AND (a.mode IS NULL OR a.mode = $1)`, [mode])).rows;
  return rows.map(r => ({
    source: 'alert', alertId: Number(r.alert_id), severity: ALERT_SEVERITY[r.severity], kind: r.type, title: r.title,
    detail: r.body, strategyId: r.strategy_id, strategyName: r.strategy_name ?? r.labels.strategy ?? null,
    sessionId: r.session_id, listingId: r.listing_id, symbol: r.labels.symbol ?? null, exchangeId: r.exchange_id,
    exchangeName: r.exchange_name ?? r.labels.exchange ?? null, accountId: r.account_id,
    accountLabel: r.labels.account ?? null, actor: r.actor, subject: r.labels.subject ?? null,
    since: r.first_seen.toISOString(), acknowledgedBy: r.acknowledged_by, acknowledgedReason: r.acknowledged_reason,
  }));
}

export async function attention(client: PoolClient, mode: 'live' | 'paper', now: Date): Promise<AttentionItem[]> {
  const findings = (await runRules(client, now)).filter(f => f.visibleIn.includes(mode));
  const open = new Map<string, OpenAlert>((await client.query(
    `SELECT key, alert_id, acknowledged_by, acknowledged_reason FROM alert.alert
     WHERE status IN ('PENDING', 'FIRING') AND key = ANY($1)`,
    [findings.map(f => f.key)])).rows.map(r => [r.key,
    { alertId: Number(r.alert_id), by: r.acknowledged_by, reason: r.acknowledged_reason }]));
  const items = [...findings.map(f => toItem(f, open)), ...await reportedAlerts(client, mode)];
  // What nobody has taken first; then within a severity, the longest-standing first, and problems that are only a
  // current state (no start time) after.
  return items.sort((a, b) => Number(a.acknowledgedBy !== null) - Number(b.acknowledgedBy !== null)
    || ORDER[a.severity] - ORDER[b.severity]
    || (a.since === null ? 1 : 0) - (b.since === null ? 1 : 0)
    || (a.since ?? '').localeCompare(b.since ?? ''));
}

export const handler = async (event: APIGatewayProxyEvent) => {
  let mode;
  try {
    mode = parseMode(event.queryStringParameters?.mode);
    if (!mode) throw new Error('mode is required');
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const now = new Date();
    return createResponse(200, { asOf: now.toISOString(), items: await attention(client, mode, now) });
  } catch (error) {
    console.error('Attention error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
