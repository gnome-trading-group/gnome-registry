import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';
import { avgEntryPrice, markPrice, PositionState } from './ledger-math';
import { lifetimePnl, SessionPnl, sessionPnl } from './pnl-math';
import {
  ListingInfo, loadListingInfo, loadSessionStates, loadStrategyState, SessionListingState, startOfDay,
  StrategyListingState,
} from './pnl-state';

// The PnL the controller shows, computed here once so the page never sums scaled integers itself. Money, prices and
// quantities are scaled-integer strings; times are ISO UTC.
//   ?sessionId=             one session: its PnL since it started, split into carry and trading, per listing
//   ?sessionIds=a,b         those sessions' totals, for a page of a sessions table
//   ?strategyId=&mode=&tz=  a strategy's lifetime and today's PnL, and what it holds per listing
//   ?mode=&tz=              every strategy's lifetime and today's PnL

const MAX_SESSION_IDS = 100;

type Totals = Record<string, string>;

function strings(values: Record<string, bigint>): Totals {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.toString()]));
}

function sessionTotals(pnls: SessionPnl[]) {
  const sum = (pick: (p: SessionPnl) => bigint) => pnls.reduce((acc, p) => acc + pick(p), 0n);
  return {
    total: sum(p => p.total),
    realized: sum(p => p.realized),
    unrealized: sum(p => p.unrealized),
    fees: sum(p => p.fees),
    carry: sum(p => p.carry),
    trading: sum(p => p.trading),
    openingUnrealized: sum(p => p.openingUnrealized),
  };
}

function listingFields(info: ListingInfo | undefined, listingId: number) {
  return {
    listingId,
    symbol: info?.symbol ?? null,
    exchangeId: info?.exchangeId ?? null,
    tickSize: info?.tickSize ?? null,
    lotSize: info?.lotSize ?? null,
  };
}

function positionFields(position: PositionState) {
  return {
    netQuantity: position.netQuantity.toString(),
    avgEntryPrice: avgEntryPrice(position).toString(),
  };
}

async function needsReview(client: PoolClient, strategyId: number, mode: string): Promise<Set<number>> {
  const rows = (await client.query(
    'SELECT listing_id FROM ledger.position WHERE strategy_id = $1 AND mode = $2 AND needs_review',
    [strategyId, mode])).rows;
  return new Set(rows.map(r => r.listing_id));
}

export async function sessionSummary(client: PoolClient, sessionId: string, now: Date) {
  const states = await loadSessionStates(client, [sessionId], now);
  const session = (await client.query(
    'SELECT strategy_id, mode, status, started_at, stopped_at FROM strategy.session WHERE session_id = $1',
    [sessionId])).rows[0];
  if (!session) return null;
  const info = await loadListingInfo(client, states.map(s => s.listingId));
  const review = await needsReview(client, session.strategy_id, session.mode);
  const counts = (await client.query(`
    SELECT
      (SELECT count(*) FROM ledger.fill WHERE session_id = $1 AND source IN ('VENUE', 'RECOVERY')) AS fills,
      (SELECT count(*) FROM ledger.order WHERE session_id = $1) AS orders,
      (SELECT count(*) FROM ledger.order WHERE session_id = $1 AND status = 'OPEN') AS open_orders`,
  [sessionId])).rows[0];
  const refusals = (await client.query(
    'SELECT listing_id, reason, count FROM ledger.reject_count WHERE session_id = $1 ORDER BY count DESC',
    [sessionId])).rows;

  const pnls = states.map(state => sessionPnl(state));
  const opening = states.some(s => s.startedFlat) ? 'FLAT'
    : states.some(s => s.opening.netQuantity !== 0n) ? 'INHERITED' : 'NONE';
  return {
    scope: {
      kind: 'session', sessionId, strategyId: session.strategy_id, mode: session.mode, status: session.status,
      startedAt: session.started_at, stoppedAt: session.stopped_at,
    },
    asOf: (session.stopped_at && session.stopped_at < now ? session.stopped_at : now).toISOString(),
    opening,
    totals: strings(sessionTotals(pnls)),
    counts: {
      fills: Number(counts.fills),
      orders: Number(counts.orders),
      openOrders: Number(counts.open_orders),
      refused: refusals.reduce((acc, r) => acc + Number(r.count), 0),
    },
    refusals: refusals.map(r => ({ listingId: r.listing_id, reason: r.reason, count: Number(r.count) })),
    listings: states.map((state, i) => sessionListingRow(state, pnls[i], info, review)),
  };
}

function sessionListingRow(
  state: SessionListingState, p: SessionPnl, info: Map<number, ListingInfo>, review: Set<number>,
) {
  return {
    ...listingFields(info.get(state.listingId), state.listingId),
    ...positionFields(state.current),
    markPrice: markPrice(state.mark).toString(),
    bid: state.mark?.bid.toString() ?? null,
    ask: state.mark?.ask.toString() ?? null,
    markTime: state.markTime,
    ...strings({
      total: p.total, realized: p.realized, unrealized: p.unrealized, fees: p.fees, carry: p.carry, trading: p.trading,
    }),
    opening: {
      source: state.startedFlat ? 'FLAT' : state.opening.netQuantity !== 0n ? 'INHERITED' : 'NONE',
      ...positionFields(state.opening),
      markPrice: markPrice(state.openingMark).toString(),
      unrealized: p.openingUnrealized.toString(),
      markMissing: p.openingMarkMissing,
    },
    version: state.version,
    needsReview: review.has(state.listingId),
    lastFillAt: state.lastFillAt,
  };
}

export async function sessionsTotals(client: PoolClient, sessionIds: string[], now: Date) {
  const states = await loadSessionStates(client, sessionIds, now);
  const fills = (await client.query(`
    SELECT session_id, count(*) AS fills FROM ledger.fill
    WHERE session_id = ANY($1::text[]) AND source IN ('VENUE', 'RECOVERY') GROUP BY session_id`,
  [sessionIds])).rows;
  return sessionIds.map(sessionId => {
    const own = states.filter(s => s.sessionId === sessionId);
    return {
      sessionId,
      opening: own.some(s => s.startedFlat) ? 'FLAT' : own.some(s => s.opening.netQuantity !== 0n) ? 'INHERITED' : 'NONE',
      totals: strings(sessionTotals(own.map(s => sessionPnl(s)))),
      fills: Number(fills.find(f => f.session_id === sessionId)?.fills ?? 0),
    };
  });
}

function lifetimeTotals(listings: StrategyListingState[]) {
  return listings.reduce((acc, l) => {
    const p = lifetimePnl(l.position, l.mark);
    return {
      total: acc.total + p.total,
      realized: acc.realized + p.realized,
      unrealized: acc.unrealized + p.unrealized,
      fees: acc.fees + p.fees,
    };
  }, { total: 0n, realized: 0n, unrealized: 0n, fees: 0n });
}

export async function strategySummary(client: PoolClient, strategyId: number, mode: string, timeZone: string, now: Date) {
  const dayStart = await startOfDay(client, now, timeZone);
  const current = await loadStrategyState(client, mode, strategyId, now);
  const atDayStart = await loadStrategyState(client, mode, strategyId, dayStart);
  const sessionIds = (await client.query(
    'SELECT session_id FROM strategy.session WHERE strategy_id = $1 AND mode = $2', [strategyId, mode],
  )).rows.map(r => r.session_id);
  const sessionPnls = (await loadSessionStates(client, sessionIds, now)).map(s => sessionPnl(s));
  const modes = (await client.query(
    'SELECT DISTINCT mode FROM strategy.session WHERE strategy_id = $1', [strategyId])).rows.map(r => r.mode);
  const info = await loadListingInfo(client, current.listings.map(l => l.listingId));
  const review = await needsReview(client, strategyId, mode);

  const lifetime = lifetimeTotals(current.listings);
  const startOfToday = lifetimeTotals(atDayStart.listings);
  return {
    scope: { kind: 'strategy', strategyId, mode, timeZone, dayStart: dayStart.toISOString() },
    asOf: now.toISOString(),
    modesWithData: modes,
    totals: strings({
      lifetime: lifetime.total,
      today: lifetime.total - startOfToday.total,
      realized: lifetime.realized,
      unrealized: lifetime.unrealized,
      fees: lifetime.fees,
      // Mark moves on inventory held while no session ran, reset write-offs and adjustments.
      betweenSessions: lifetime.total - sessionPnls.reduce((acc, p) => acc + p.total, 0n),
    }),
    openPositions: current.listings.filter(l => l.position.netQuantity !== 0n).length,
    listings: current.listings.map(l => {
      const p = lifetimePnl(l.position, l.mark);
      const before = atDayStart.listings.find(d => d.listingId === l.listingId);
      const todayStart = before ? lifetimePnl(before.position, before.mark).total : 0n;
      return {
        ...listingFields(info.get(l.listingId), l.listingId),
        ...positionFields(l.position),
        markPrice: markPrice(l.mark).toString(),
        bid: l.mark?.bid.toString() ?? null,
        ask: l.mark?.ask.toString() ?? null,
        markTime: l.markTime,
        ...strings({ total: p.total, today: p.total - todayStart, realized: p.realized, unrealized: p.unrealized, fees: p.fees }),
        version: l.version,
        needsReview: review.has(l.listingId),
        lastFillAt: l.lastFillAt,
      };
    }),
  };
}

export async function firmSummary(client: PoolClient, mode: string, timeZone: string, now: Date) {
  const dayStart = await startOfDay(client, now, timeZone);
  const current = await loadStrategyState(client, mode, null, now);
  const atDayStart = await loadStrategyState(client, mode, null, dayStart);
  const strategyIds = [...new Set(current.listings.map(l => l.strategyId))];
  const strategies = strategyIds.map(strategyId => {
    const own = current.listings.filter(l => l.strategyId === strategyId);
    const lifetime = lifetimeTotals(own);
    const startOfToday = lifetimeTotals(atDayStart.listings.filter(l => l.strategyId === strategyId));
    return {
      strategyId,
      ...strings({
        lifetime: lifetime.total, today: lifetime.total - startOfToday.total, unrealized: lifetime.unrealized,
      }),
      openPositions: own.filter(l => l.position.netQuantity !== 0n).length,
    };
  });
  const lifetime = lifetimeTotals(current.listings);
  const startOfToday = lifetimeTotals(atDayStart.listings);
  return {
    scope: { kind: 'firm', mode, timeZone, dayStart: dayStart.toISOString() },
    asOf: now.toISOString(),
    totals: strings({
      lifetime: lifetime.total, today: lifetime.total - startOfToday.total, realized: lifetime.realized,
      unrealized: lifetime.unrealized, fees: lifetime.fees,
    }),
    strategies,
  };
}

export class BadRequest extends Error {}

export function parseTimeZone(value: string | undefined): string {
  const timeZone = value || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new BadRequest(`tz must be an IANA time zone, not ${timeZone}`);
  }
  return timeZone;
}

function parseSessionIds(value: string): string[] {
  const ids = value.split(',').filter(Boolean);
  if (ids.length === 0 || ids.length > MAX_SESSION_IDS || !ids.every(isSessionId)) {
    throw new BadRequest(`sessionIds must be 1 to ${MAX_SESSION_IDS} session ids`);
  }
  return ids;
}

export async function summarize(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
  if (params.sessionId) {
    if (!isSessionId(params.sessionId)) throw new BadRequest('sessionId must be a session id');
    return sessionSummary(client, params.sessionId, now);
  }
  if (params.sessionIds) return sessionsTotals(client, parseSessionIds(params.sessionIds), now);
  let mode;
  try {
    mode = parseMode(params.mode);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
  if (!mode) throw new BadRequest('mode is required');
  const timeZone = parseTimeZone(params.tz);
  const strategyId = parsePositiveInt(params.strategyId);
  if (Number.isNaN(strategyId)) throw new BadRequest('strategyId must be a positive integer');
  return strategyId === undefined
    ? firmSummary(client, mode, timeZone, now)
    : strategySummary(client, strategyId, mode, timeZone, now);
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const summary = await summarize(client, event.queryStringParameters ?? {}, new Date());
    if (summary === null) return createResponse(404, { message: 'No such session' });
    return createResponse(200, summary);
  } catch (error) {
    if (error instanceof BadRequest) return createResponse(400, { message: error.message });
    console.error('PnL summary error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
