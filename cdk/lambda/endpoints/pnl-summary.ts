import { APIGatewayProxyEvent } from 'aws-lambda';
import { latestAccruals, sessionRewardTotals, sessionsRewardGross } from '../rewards/accruals';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';
import { avgEntryPrice, markPrice, PositionState } from './ledger-math';
import { fillImpact, lifetimePnl, SessionPnl, sessionPnl } from './pnl-math';
import {
  AfterSession, ListingInfo, loadAfterSessions, loadListingInfo, loadOutOfSessionFills, loadRewards, loadSessionStates,
  loadStrategyState, OutOfSessionSource, PositionFill, RewardRow, SessionListingState, startOfDay, StrategyListingState,
  sumRewards,
} from './pnl-state';

// The PnL the controller shows, computed here once so the page never sums scaled integers itself. Money, prices and
// quantities are scaled-integer strings; times are ISO UTC.
//   ?sessionId=             one session: its PnL since it started, split into carry and trading, per listing
//   ?sessionIds=a,b         those sessions' totals, for a page of a sessions table
//   ?strategyId=&mode=&tz=  a strategy's lifetime and today's PnL, and its rows active today: held, needing review
//                           or traded since the day started; the flat rest are summed in history
//     &listingId=           that listing's rows instead, active or not
//     &positions=flat       the flat rest themselves, newest first: &limit= (default 100, max 500), &before=nextBefore
//   ?mode=&tz=              every strategy's lifetime and today's PnL, and the firm's non-trading PnL
//
// A strategy's lifetime PnL includes the venue rewards given to it (rewards, outside every session); the firm's adds
// what non-trading money stays the firm's.

const MAX_SESSION_IDS = 100;
const DEFAULT_FLAT_LIMIT = 100;
const MAX_FLAT_LIMIT = 500;

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
  const accruals = await latestAccruals(client, { sessionId });
  const rewardTotals = sessionRewardTotals(accruals);

  const pnls = states.map(state => sessionPnl(state));
  const open = states.filter(leftOpen);
  const loaded = await loadAfterSessions(client, open);
  const after = new Map(open.map((state, i) => [state, loaded[i]]));
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
    // The session's own estimate of venue liquidity rewards (paper), outside its trading PnL; none in live.
    rewards: {
      ...strings({ estimatedGross: rewardTotals.gross, estimatedPaid: rewardTotals.paid }),
      programs: accruals,
    },
    listings: states.map((state, i) => ({
      ...sessionListingRow(state, pnls[i], info, review),
      afterSession: after.has(state) ? afterSessionRow(after.get(state) as AfterSession) : null,
    })),
  };
}

function leftOpen(state: SessionListingState): boolean {
  return state.stoppedAt !== null && state.current.netQuantity !== 0n;
}

function impactOf(fill: PositionFill): bigint {
  return fillImpact(fill.before, fill.after, fill.realized, fill.fees, fill.mark);
}

const AFTER_SESSION_KINDS: Record<string, string> = {
  SETTLEMENT: 'SETTLED', MANUAL: 'CLOSED_MANUALLY', ADJUSTMENT: 'ADJUSTED', RESET: 'RESET',
};

// What became of a position the session stopped holding, for reading alongside its PnL, which it never changes: a
// settlement or anything else booked against it later counts in the strategy's PnL outside sessions.
function afterSessionRow(a: AfterSession) {
  const { fill } = a;
  // A later session starting flat writes the position off with a reset of its own.
  const inherited = a.nextSessionId !== null && fill?.source !== 'RESET'
    && (fill === null || (a.nextSessionStartedAt as Date) <= fill.recordedAt);
  if (inherited) {
    return { kind: 'INHERITED', at: a.nextSessionStartedAt, sessionId: a.nextSessionId, price: null, impact: null,
      settlementPrice: null };
  }
  if (fill !== null) {
    const kind = AFTER_SESSION_KINDS[fill.source];
    if (!kind) {
      return { kind: 'INHERITED', at: fill.recordedAt, sessionId: fill.sessionId, price: null, impact: null,
        settlementPrice: null };
    }
    return {
      kind, at: fill.recordedAt, sessionId: fill.sessionId, price: fill.price?.toString() ?? null,
      impact: impactOf(fill).toString(), settlementPrice: kind === 'SETTLED' ? fill.price?.toString() ?? null : null,
    };
  }
  return {
    kind: a.eventContract ? 'AWAITING_SETTLEMENT' : 'OPEN', at: null, sessionId: null, price: null, impact: null,
    settlementPrice: a.settlementPrice?.toString() ?? null,
  };
}

const OUTSIDE_SESSION_TERMS: Record<OutOfSessionSource, 'settlements' | 'manual' | 'adjustments' | 'resets'> = {
  SETTLEMENT: 'settlements', MANUAL: 'manual', ADJUSTMENT: 'adjustments', RESET: 'resets',
};

// How a strategy's lifetime PnL differs from the sum of its sessions' PnL: what each kind of fill outside them
// changed it by, the venue rewards it was given, and carry, the mark moving on inventory no session held, which is
// whatever remains.
function outsideSessions(total: bigint, fills: PositionFill[], rewards: bigint) {
  const terms = { settlements: 0n, manual: 0n, adjustments: 0n, resets: 0n };
  for (const fill of fills) terms[OUTSIDE_SESSION_TERMS[fill.source as OutOfSessionSource]] += impactOf(fill);
  const booked = terms.settlements + terms.manual + terms.adjustments + terms.resets + rewards;
  return strings({ total, ...terms, rewards, carry: total - booked });
}

// Rewards given per listing, for the rows; a taker rebate is the strategy's, on no listing.
function rewardsByListing(rows: RewardRow[]): Map<number, bigint> {
  const byListing = new Map<number, bigint>();
  for (const r of rows) {
    if (r.listingId !== null) byListing.set(r.listingId, (byListing.get(r.listingId) ?? 0n) + r.amount);
  }
  return byListing;
}

function sessionListingRow(
  state: SessionListingState, p: SessionPnl, info: Map<number, ListingInfo>, review: Set<number>,
) {
  return {
    ...listingFields(info.get(state.listingId), state.listingId),
    ...positionFields(state.current),
    markPrice: markPrice(state.mark)?.toString() ?? null,
    bid: state.mark?.bid.toString() ?? null,
    ask: state.mark?.ask.toString() ?? null,
    markTime: state.markTime,
    ...strings({
      total: p.total, realized: p.realized, unrealized: p.unrealized, fees: p.fees, carry: p.carry, trading: p.trading,
    }),
    opening: {
      source: state.startedFlat ? 'FLAT' : state.opening.netQuantity !== 0n ? 'INHERITED' : 'NONE',
      ...positionFields(state.opening),
      markPrice: markPrice(state.openingMark)?.toString() ?? null,
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
  const rewardGross = await sessionsRewardGross(client, sessionIds);
  return sessionIds.map(sessionId => {
    const own = states.filter(s => s.sessionId === sessionId);
    return {
      sessionId,
      opening: own.some(s => s.startedFlat) ? 'FLAT' : own.some(s => s.opening.netQuantity !== 0n) ? 'INHERITED' : 'NONE',
      totals: strings(sessionTotals(own.map(s => sessionPnl(s)))),
      fills: Number(fills.find(f => f.session_id === sessionId)?.fills ?? 0),
      rewardsEstimated: (rewardGross.get(sessionId) ?? 0n).toString(),
    };
  });
}

async function accountLabels(client: PoolClient, accountIds: (number | null)[]): Promise<Map<number, string>> {
  const ids = [...new Set(accountIds.filter((id): id is number => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = (await client.query(
    'SELECT account_id, label FROM account_master.venue_account WHERE account_id = ANY($1::int[])', [ids])).rows;
  return new Map(rows.map(r => [r.account_id, r.label]));
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

// Today's PnL on a row moves only while it is held or traded: a flat row untraded since the day started is history,
// its PnL the realized and fees it closed with.
function activeToday(l: StrategyListingState, review: Set<number>, dayStart: Date): boolean {
  return l.position.netQuantity !== 0n || review.has(l.listingId) || l.lastFillAt >= dayStart;
}

const rowKey = (l: StrategyListingState) => `${l.listingId}/${l.accountId}`;

async function strategyRows(
  client: PoolClient, rows: StrategyListingState[], todayStart: Map<string, bigint>, review: Set<number>,
  rewards: Map<number, bigint>,
) {
  // A listing traded through several accounts has several rows; its rewards go on the first.
  const shown = new Set<number>();
  const info = await loadListingInfo(client, rows.map(l => l.listingId));
  const labels = await accountLabels(client, rows.map(l => l.accountId));
  return rows.map(l => {
    const p = lifetimePnl(l.position, l.mark);
    return {
      ...listingFields(info.get(l.listingId), l.listingId),
      accountId: l.accountId,
      accountLabel: l.accountId === null ? null : labels.get(l.accountId) ?? null,
      ...positionFields(l.position),
      markPrice: markPrice(l.mark)?.toString() ?? null,
      bid: l.mark?.bid.toString() ?? null,
      ask: l.mark?.ask.toString() ?? null,
      markTime: l.markTime,
      // A row first traded today started the day at nothing.
      ...strings({
        total: p.total, today: p.total - (todayStart.get(rowKey(l)) ?? 0n), realized: p.realized,
        unrealized: p.unrealized, fees: p.fees,
        rewards: shown.has(l.listingId) ? 0n : (shown.add(l.listingId), rewards.get(l.listingId) ?? 0n),
      }),
      version: l.version,
      needsReview: review.has(l.listingId),
      lastFillAt: l.lastFillAt,
    };
  });
}

export async function strategySummary(
  client: PoolClient, strategyId: number, mode: string, timeZone: string, now: Date, listingId?: number,
) {
  const dayStart = await startOfDay(client, now, timeZone);
  const current = await loadStrategyState(client, mode, strategyId, now);
  const atDayStart = await loadStrategyState(client, mode, strategyId, dayStart);
  const sessionIds = (await client.query(
    'SELECT session_id FROM strategy.session WHERE strategy_id = $1 AND mode = $2', [strategyId, mode],
  )).rows.map(r => r.session_id);
  const sessionPnls = (await loadSessionStates(client, sessionIds, now)).map(s => sessionPnl(s));
  const outside = await loadOutOfSessionFills(client, mode, strategyId, now);
  const rewardRows = await loadRewards(client, mode, { strategyId, firm: false }, now);
  const rewards = sumRewards(rewardRows);
  const rewardsToday = rewards - sumRewards(rewardRows, dayStart);
  const modes = (await client.query(
    'SELECT DISTINCT mode FROM strategy.session WHERE strategy_id = $1', [strategyId])).rows.map(r => r.mode);
  const review = await needsReview(client, strategyId, mode);

  const active = current.listings.filter(l => activeToday(l, review, dayStart));
  const history = lifetimeTotals(current.listings.filter(l => !activeToday(l, review, dayStart)));
  const shown = listingId === undefined ? active : current.listings.filter(l => l.listingId === listingId);
  const todayStart = new Map(atDayStart.listings.map(l => [rowKey(l), lifetimePnl(l.position, l.mark).total]));
  const lifetime = lifetimeTotals(current.listings);
  const startOfToday = lifetimeTotals(atDayStart.listings);
  return {
    scope: { kind: 'strategy', strategyId, mode, timeZone, dayStart: dayStart.toISOString() },
    asOf: now.toISOString(),
    modesWithData: modes,
    totals: {
      ...strings({
        lifetime: lifetime.total + rewards,
        today: lifetime.total - startOfToday.total + rewardsToday,
        realized: lifetime.realized,
        unrealized: lifetime.unrealized,
        fees: lifetime.fees,
        rewards,
        rewardsToday,
      }),
      outsideSessions: outsideSessions(
        lifetime.total + rewards - sessionPnls.reduce((acc, p) => acc + p.total, 0n), outside, rewards),
    },
    openPositions: current.listings.filter(l => l.position.netQuantity !== 0n).length,
    history: {
      count: current.listings.length - active.length,
      ...strings({ total: history.total, realized: history.realized, fees: history.fees }),
    },
    listings: await strategyRows(client, shown, todayStart, review, rewardsByListing(rewardRows)),
  };
}

// The rows strategySummary leaves out, newest first. Untraded since the day started, each one's today is zero.
export async function flatPositions(
  client: PoolClient, strategyId: number, mode: string, timeZone: string, now: Date, limit: number, before?: bigint,
) {
  const dayStart = await startOfDay(client, now, timeZone);
  const current = await loadStrategyState(client, mode, strategyId, now);
  const review = await needsReview(client, strategyId, mode);
  const flat = current.listings
    .filter(l => !activeToday(l, review, dayStart) && (before === undefined || BigInt(l.fillId) < before))
    .sort((a, b) => (BigInt(b.fillId) > BigInt(a.fillId) ? 1 : -1))
    .slice(0, limit);
  const todayStart = new Map(flat.map(l => [rowKey(l), lifetimePnl(l.position, l.mark).total]));
  const rewards = rewardsByListing(await loadRewards(client, mode, { strategyId, firm: false }, now));
  return {
    rows: await strategyRows(client, flat, todayStart, review, rewards),
    nextBefore: flat.length === limit ? flat[flat.length - 1].fillId : null,
  };
}

export async function firmSummary(client: PoolClient, mode: string, timeZone: string, now: Date) {
  const dayStart = await startOfDay(client, now, timeZone);
  const current = await loadStrategyState(client, mode, null, now);
  const atDayStart = await loadStrategyState(client, mode, null, dayStart);
  const rewardRows = await loadRewards(client, mode, { strategyId: null, firm: true }, now);
  const given = rewardRows.filter(r => r.strategyId !== null);
  const firmOnly = rewardRows.filter(r => r.strategyId === null);
  const strategyIds = [...new Set([...current.listings.map(l => l.strategyId), ...given.map(r => r.strategyId as number)])]
    .sort((a, b) => a - b);
  const strategies = strategyIds.map(strategyId => {
    const own = current.listings.filter(l => l.strategyId === strategyId);
    const ownRewards = given.filter(r => r.strategyId === strategyId);
    const rewards = sumRewards(ownRewards);
    const lifetime = lifetimeTotals(own);
    const startOfToday = lifetimeTotals(atDayStart.listings.filter(l => l.strategyId === strategyId));
    return {
      strategyId,
      ...strings({
        lifetime: lifetime.total + rewards,
        today: lifetime.total - startOfToday.total + rewards - sumRewards(ownRewards, dayStart),
        unrealized: lifetime.unrealized,
        rewards,
      }),
      openPositions: own.filter(l => l.position.netQuantity !== 0n).length,
    };
  });
  const trading = lifetimeTotals(current.listings);
  const tradingAtDayStart = lifetimeTotals(atDayStart.listings);
  const rewards = sumRewards(given);
  const rewardsToday = rewards - sumRewards(given, dayStart);
  const nonTrading = nonTradingTotals(firmOnly, dayStart);
  return {
    scope: { kind: 'firm', mode, timeZone, dayStart: dayStart.toISOString() },
    asOf: now.toISOString(),
    totals: strings({
      lifetime: trading.total + rewards + nonTrading.lifetime,
      today: trading.total - tradingAtDayStart.total + rewardsToday + nonTrading.today,
      realized: trading.realized,
      unrealized: trading.unrealized,
      fees: trading.fees,
      rewards,
      rewardsToday,
      nonTrading: nonTrading.lifetime,
      nonTradingToday: nonTrading.today,
    }),
    nonTrading: {
      ...strings({ lifetime: nonTrading.lifetime, today: nonTrading.today }),
      byProgram: nonTrading.byProgram,
      byExchange: nonTrading.byExchange,
    },
    strategies,
  };
}

// The firm's own non-trading PnL, lifetime and since the day started, by program and by exchange.
function nonTradingTotals(rows: RewardRow[], dayStart: Date) {
  const group = (key: (r: RewardRow) => string) => {
    const groups: Record<string, { lifetime: bigint; today: bigint }> = {};
    for (const r of rows) {
      const g = groups[key(r)] ??= { lifetime: 0n, today: 0n };
      g.lifetime += r.amount;
      if (r.occurredAt > dayStart) g.today += r.amount;
    }
    return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, strings(v)]));
  };
  const lifetime = sumRewards(rows);
  return {
    lifetime, today: lifetime - sumRewards(rows, dayStart), byProgram: group(r => r.program), byExchange: group(r => r.exchangeCode),
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
  if (strategyId === undefined) return firmSummary(client, mode, timeZone, now);
  if (params.positions !== undefined) {
    if (params.positions !== 'flat') throw new BadRequest('positions must be flat');
    const limit = parsePositiveInt(params.limit) ?? DEFAULT_FLAT_LIMIT;
    if (Number.isNaN(limit) || limit > MAX_FLAT_LIMIT) throw new BadRequest(`limit must be 1 to ${MAX_FLAT_LIMIT}`);
    if (params.before !== undefined && !/^[1-9][0-9]{0,18}$/.test(params.before)) {
      throw new BadRequest('before must be a nextBefore from an earlier page');
    }
    return flatPositions(client, strategyId, mode, timeZone, now, limit,
      params.before === undefined ? undefined : BigInt(params.before));
  }
  const listingId = parsePositiveInt(params.listingId);
  if (Number.isNaN(listingId)) throw new BadRequest('listingId must be a positive integer');
  return strategySummary(client, strategyId, mode, timeZone, now, listingId);
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
