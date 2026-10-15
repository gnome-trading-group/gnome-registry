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

const ORDER: Record<DisplaySeverity, number> = { critical: 0, warning: 1, info: 2 };

export interface AttentionItem {
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
}

function toItem(f: Finding, acknowledged: Map<string, string>): AttentionItem {
  return {
    severity: f.severity, kind: f.kind, title: f.title, detail: f.detail, strategyId: f.strategyId,
    strategyName: f.strategyName, sessionId: f.sessionId, listingId: f.listingId, symbol: f.symbol,
    exchangeId: f.exchangeId, exchangeName: f.exchangeName, accountId: f.accountId, accountLabel: f.accountLabel,
    actor: f.actor, subject: f.subject, since: f.since, acknowledgedBy: acknowledged.get(f.key) ?? null,
  };
}

export async function attention(client: PoolClient, mode: 'live' | 'paper', now: Date): Promise<AttentionItem[]> {
  const findings = (await runRules(client, now)).filter(f => f.visibleIn.includes(mode));
  const acknowledged = new Map<string, string>((await client.query(
    `SELECT key, acknowledged_by FROM alert.alert
     WHERE status IN ('PENDING', 'FIRING') AND acknowledged_by IS NOT NULL AND key = ANY($1)`,
    [findings.map(f => f.key)])).rows.map(r => [r.key, r.acknowledged_by]));
  const items = findings.map(f => toItem(f, acknowledged));
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
