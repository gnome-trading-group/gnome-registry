import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId } from './ledger-common';
import { MarkInputs, PositionState, toBigInt } from './ledger-math';
import { PnlRow, pnlRow, toMark } from './pnl-common';

// A session's PnL over time, per listing: the position its fills leave (starting from what it inherited), valued at
// the listing's mark at each moment. Marks are taken per bucket (the last one in each), so a long window stays a
// bounded number of points; every fill is its own point.
const MIN_STEP_MS = 30_000;
const MAX_POINTS_PER_LISTING = 1500;

interface Event {
  time: Date;
  fill?: PositionState;
  mark?: MarkInputs;
}

export function stepMs(start: Date, end: Date): number {
  return Math.max(MIN_STEP_MS, Math.ceil((end.getTime() - start.getTime()) / MAX_POINTS_PER_LISTING));
}

export async function sessionSeries(client: PoolClient, sessionId: string, start?: Date, end?: Date): Promise<PnlRow[]> {
  const session = (await client.query(
    'SELECT strategy_id, mode, started_at, stopped_at FROM strategy.session WHERE session_id = $1',
    [sessionId])).rows[0];
  if (!session) return [];
  // Clamped to the session's own life: before it started, an inherited position belonged to earlier sessions.
  const from = latest(start, session.started_at);
  const to = earliest(end, session.stopped_at ?? new Date());
  const step = stepMs(from, to);

  const listings: number[] = (await client.query(`
    SELECT listing_id FROM strategy.session_listing WHERE session_id = $1
    UNION SELECT DISTINCT listing_id FROM ledger.fill WHERE session_id = $1`, [sessionId])).rows.map(r => r.listing_id);
  if (listings.length === 0) return [];

  // What each listing held when the window opens: the session's own last fill before it, else what it inherited.
  const opening = (await client.query(`
    SELECT DISTINCT ON (listing_id) listing_id, net_quantity_after, total_cost_after,
      CASE WHEN session_id = $1 THEN realized_pnl_after ELSE 0 END AS realized_pnl_after,
      CASE WHEN session_id = $1 THEN fees_after ELSE 0 END AS fees_after
    FROM ledger.fill
    WHERE listing_id = ANY($2::int[]) AND strategy_id = $3 AND mode = $4 AND source <> 'GAP'
      AND ((session_id = $1 AND recorded_at < $5) OR (session_id IS DISTINCT FROM $1 AND recorded_at < $6))
    ORDER BY listing_id, fill_id DESC`,
  [sessionId, listings, session.strategy_id, session.mode, from, session.started_at])).rows;

  const fills = (await client.query(`
    SELECT listing_id, recorded_at, net_quantity_after, total_cost_after, realized_pnl_after, fees_after
    FROM ledger.fill
    WHERE session_id = $1 AND source <> 'GAP' AND recorded_at >= $2 AND recorded_at <= $3
    ORDER BY fill_id`, [sessionId, from, to])).rows;

  const marks = (await client.query(`
    (SELECT DISTINCT ON (listing_id) listing_id, ts, bid, ask, last_trade FROM ledger.mark
     WHERE listing_id = ANY($1::int[]) AND ts < $2 ORDER BY listing_id, ts DESC)
    UNION ALL
    (SELECT DISTINCT ON (listing_id, date_bin($4::interval, ts, $2)) listing_id, ts, bid, ask, last_trade
     FROM ledger.mark WHERE listing_id = ANY($1::int[]) AND ts >= $2 AND ts <= $3
     ORDER BY listing_id, date_bin($4::interval, ts, $2), ts DESC)`,
  [listings, from, to, `${step} milliseconds`])).rows;

  const rows: PnlRow[] = [];
  for (const listingId of listings) {
    const open = opening.find(r => r.listing_id === listingId);
    let position: PositionState = {
      netQuantity: toBigInt(open?.net_quantity_after),
      totalCost: toBigInt(open?.total_cost_after),
      realizedPnl: toBigInt(open?.realized_pnl_after),
      totalFees: toBigInt(open?.fees_after),
    };
    let mark: MarkInputs | null = null;
    const events: Event[] = [];
    for (const m of marks.filter(r => r.listing_id === listingId)) {
      if (m.ts < from) mark = toMark(m);
      else events.push({ time: m.ts, mark: toMark(m) as MarkInputs });
    }
    for (const f of fills.filter(r => r.listing_id === listingId)) {
      events.push({
        time: f.recorded_at,
        fill: {
          netQuantity: toBigInt(f.net_quantity_after), totalCost: toBigInt(f.total_cost_after),
          realizedPnl: toBigInt(f.realized_pnl_after), totalFees: toBigInt(f.fees_after),
        },
      });
    }
    events.sort((a, b) => a.time.getTime() - b.time.getTime());

    const key = { strategyId: session.strategy_id, sessionId, listingId, mode: session.mode };
    rows.push(pnlRow({ ...key, time: from }, position, mark));
    for (const event of events) {
      if (event.fill) position = event.fill;
      if (event.mark) mark = event.mark;
      rows.push(pnlRow({ ...key, time: event.time }, position, mark));
    }
  }
  return rows.sort((a, b) => b.snapshot_time.localeCompare(a.snapshot_time));
}

function latest(a: Date | undefined, b: Date): Date {
  return a && a > b ? a : b;
}

function earliest(a: Date | undefined, b: Date): Date {
  return a && a < b ? a : b;
}

function parseTime(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`${name} must be an ISO time`);
  return time;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const params = event.queryStringParameters ?? {};
  let start: Date | undefined;
  let end: Date | undefined;
  try {
    if (!isSessionId(params.sessionId)) throw new Error('sessionId is required');
    start = parseTime(params.startTime, 'startTime');
    end = parseTime(params.endTime, 'endTime');
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    return createResponse(200, await sessionSeries(client, params.sessionId as string, start, end));
  } catch (error) {
    console.error('PnL series error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
