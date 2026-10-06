import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, parsePositiveInt } from './ledger-common';
import { toBigInt } from './ledger-math';
import { PnlRow, pnlRow, toMark } from './pnl-common';

// The latest PnL per listing, derived from fills and marks.
//   sessionId: what that session holds and has made. Realized PnL and fees are the session's own; quantity and cost
//              include inventory it inherited. An ended session is valued at the marks when it stopped.
//   otherwise: each strategy's current holdings per listing and mode (mode=paper|live, default live, or ALL), with
//              realized PnL and fees summed over all its sessions.

const LATEST_MARK = `
  LEFT JOIN LATERAL (
    SELECT bid, ask, last_trade FROM ledger.mark m
    WHERE m.listing_id = x.listing_id AND m.ts <= $AS_OF
    ORDER BY m.ts DESC LIMIT 1
  ) mk ON TRUE`;

export async function sessionRows(client: PoolClient, sessionId: string): Promise<PnlRow[]> {
  const session = (await client.query(
    'SELECT strategy_id, mode, started_at, stopped_at, status FROM strategy.session WHERE session_id = $1',
    [sessionId])).rows[0];
  if (!session) return [];
  const asOf = session.stopped_at ?? new Date();
  const result = await client.query(`
    WITH listings AS (
      SELECT listing_id FROM strategy.session_listing WHERE session_id = $1
      UNION SELECT DISTINCT listing_id FROM ledger.fill WHERE session_id = $1
    ),
    session_last AS (
      SELECT DISTINCT ON (listing_id) listing_id, net_quantity_after, total_cost_after, realized_pnl_after, fees_after,
        recorded_at
      FROM ledger.fill WHERE session_id = $1 AND source <> 'GAP'
      ORDER BY listing_id, fill_id DESC
    ),
    inherited AS (
      SELECT DISTINCT ON (listing_id) listing_id, net_quantity_after, total_cost_after
      FROM ledger.fill
      WHERE strategy_id = $2 AND mode = $3 AND source <> 'GAP' AND recorded_at < $4
      ORDER BY listing_id, fill_id DESC
    ),
    x AS (
      SELECT l.listing_id,
        COALESCE(sl.net_quantity_after, ih.net_quantity_after, 0) AS net_quantity,
        COALESCE(sl.total_cost_after, ih.total_cost_after, 0) AS total_cost,
        COALESCE(sl.realized_pnl_after, 0) AS realized_pnl,
        COALESCE(sl.fees_after, 0) AS total_fees,
        COALESCE(sl.recorded_at, $4) AS updated_at
      FROM listings l
      LEFT JOIN session_last sl ON sl.listing_id = l.listing_id
      LEFT JOIN inherited ih ON ih.listing_id = l.listing_id
    )
    SELECT x.*, mk.bid, mk.ask, mk.last_trade FROM x ${LATEST_MARK.replace('$AS_OF', '$5')}
    ORDER BY x.listing_id`,
    [sessionId, session.strategy_id, session.mode, session.started_at, asOf]);
  return result.rows.map(r => pnlRow(
    { strategyId: session.strategy_id, sessionId, listingId: r.listing_id, mode: session.mode, time: r.updated_at },
    {
      netQuantity: toBigInt(r.net_quantity), totalCost: toBigInt(r.total_cost),
      realizedPnl: toBigInt(r.realized_pnl), totalFees: toBigInt(r.total_fees),
    },
    toMark(r)));
}

export async function strategyRows(client: PoolClient, strategyId: number | undefined, modes: string[]): Promise<PnlRow[]> {
  const result = await client.query(`
    WITH session_last AS (
      SELECT DISTINCT ON (session_id, listing_id) strategy_id, listing_id, mode, realized_pnl_after, fees_after
      FROM ledger.fill
      WHERE session_id IS NOT NULL AND source <> 'GAP' AND mode = ANY($1::text[])
        AND ($2::int IS NULL OR strategy_id = $2)
      ORDER BY session_id, listing_id, fill_id DESC
    ),
    totals AS (
      SELECT strategy_id, listing_id, mode, SUM(realized_pnl_after) AS realized_pnl, SUM(fees_after) AS total_fees
      FROM session_last GROUP BY strategy_id, listing_id, mode
    ),
    x AS (
      SELECT p.strategy_id, p.listing_id, p.mode, p.net_quantity, p.total_cost, p.updated_at,
        COALESCE(t.realized_pnl, 0) AS realized_pnl, COALESCE(t.total_fees, 0) AS total_fees
      FROM ledger.position p
      LEFT JOIN totals t USING (strategy_id, listing_id, mode)
      WHERE p.mode = ANY($1::text[]) AND ($2::int IS NULL OR p.strategy_id = $2)
    )
    SELECT x.*, mk.bid, mk.ask, mk.last_trade FROM x ${LATEST_MARK.replace('$AS_OF', 'NOW()')}
    ORDER BY x.strategy_id, x.listing_id, x.mode`,
    [modes, strategyId ?? null]);
  return result.rows.map(r => pnlRow(
    { strategyId: r.strategy_id, sessionId: null, listingId: r.listing_id, mode: r.mode, time: r.updated_at },
    {
      netQuantity: toBigInt(r.net_quantity), totalCost: toBigInt(r.total_cost),
      realizedPnl: toBigInt(r.realized_pnl), totalFees: toBigInt(r.total_fees),
    },
    toMark(r)));
}

export function parseModes(mode: string | undefined): string[] {
  const value = (mode ?? 'live').toLowerCase();
  if (value === 'all') return ['paper', 'live'];
  if (value !== 'paper' && value !== 'live') throw new Error('mode must be paper, live or ALL');
  return [value];
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const params = event.queryStringParameters ?? {};
  let modes: string[];
  let strategyId: number | undefined;
  try {
    if (params.sessionId && !isSessionId(params.sessionId)) throw new Error('sessionId must be a session id');
    modes = parseModes(params.mode);
    strategyId = parsePositiveInt(params.strategyId);
    if (Number.isNaN(strategyId)) throw new Error('strategyId must be a positive integer');
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const rows = params.sessionId
      ? await sessionRows(client, params.sessionId)
      : await strategyRows(client, strategyId, modes);
    return createResponse(200, rows);
  } catch (error) {
    console.error('PnL latest error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
