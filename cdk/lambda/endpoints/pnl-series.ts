import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';
import { MarkInputs, pnl, PositionState, toBigInt } from './ledger-math';
import { lifetimePnl, pickResolution, pointTimes, sessionPnl } from './pnl-math';
import { FLAT, loadListingInfo, loadSessionStates, loadStrategyState, toMark } from './pnl-state';

// PnL over time for a chart, one point per resolution step (the smallest that keeps the series within a bounded
// number of points), each the state at that moment: the position the newest fill left, valued at the newest mark.
//   ?sessionId=            the session's PnL since it started (it starts at $0; see pnl-math)
//   ?strategyId=&mode=     the strategy's lifetime PnL, continuous across its sessions
// Optional: start, end (ISO), resolution (ms), since (ms; only points from then on, for appending to a chart).
// Every listing is carried forward between its own updates, so the totals always equal the sum of the listings.

class BadRequest extends Error {}

interface Change {
  timeMs: number;
  listingId: number;
  mark?: MarkInputs | null;
  fill?: FillRow;
}

interface FillRow {
  fill_id: string;
  source: string;
  session_id: string | null;
  listing_id: number;
  recorded_at: Date;
  net_quantity_after: string;
  total_cost_after: string;
  realized_pnl_after: string | null;
  fees_after: string | null;
  actor: string | null;
  reason: string | null;
}

interface SeriesEvent {
  time: string;
  kind: string;
  sessionId: string | null;
  listingId: number | null;
  pnlImpact: string | null;
  actor: string | null;
  reason: string | null;
}

interface Window {
  fromMs: number;
  toMs: number;
  stepMs: number;
}

function window(spanFrom: Date, spanTo: Date, params: Record<string, string | undefined>): Window {
  const requested = parsePositiveInt(params.resolution);
  if (Number.isNaN(requested)) throw new BadRequest('resolution must be a positive number of milliseconds');
  const since = params.since === undefined ? undefined : Number(params.since);
  if (since !== undefined && !Number.isFinite(since)) throw new BadRequest('since must be epoch milliseconds');
  const fromMs = spanFrom.getTime();
  const toMs = Math.max(fromMs, spanTo.getTime());
  // The step comes from the whole window, so polling with `since` keeps the chart's resolution.
  const stepMs = pickResolution(toMs - fromMs, requested);
  return { fromMs: since === undefined ? fromMs : Math.min(toMs, Math.max(fromMs, since)), toMs, stepMs };
}

function parseTime(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new BadRequest(`${name} must be an ISO time`);
  return time;
}

// Each listing's last mark at or before the window opens, then the last mark in each step inside it.
async function loadMarkChanges(client: PoolClient, listingIds: number[], w: Window): Promise<Change[]> {
  if (listingIds.length === 0) return [];
  const rows = (await client.query(`
    (SELECT DISTINCT ON (listing_id) listing_id, ts, bid, ask, last_trade FROM ledger.mark
     WHERE listing_id = ANY($1::int[]) AND ts <= $2 ORDER BY listing_id, ts DESC)
    UNION ALL
    (SELECT DISTINCT ON (listing_id, date_bin($4::interval, ts, 'epoch'::timestamptz))
       listing_id, ts, bid, ask, last_trade
     FROM ledger.mark WHERE listing_id = ANY($1::int[]) AND ts > $2 AND ts <= $3
     ORDER BY listing_id, date_bin($4::interval, ts, 'epoch'::timestamptz), ts DESC)`,
  [listingIds, new Date(w.fromMs), new Date(w.toMs), `${w.stepMs} milliseconds`])).rows;
  return rows.map(r => ({ timeMs: Math.max(w.fromMs, r.ts.getTime()), listingId: r.listing_id, mark: toMark(r) }));
}

function inOrder(changes: Change[]): Change[] {
  // Fills before marks at the same moment, and fills in the order they were booked.
  return changes.sort((a, b) => a.timeMs - b.timeMs
    || Number(Boolean(a.mark !== undefined)) - Number(Boolean(b.mark !== undefined))
    || Number(BigInt(a.fill?.fill_id ?? 0) - BigInt(b.fill?.fill_id ?? 0)));
}

function fillPosition(row: FillRow, realized: bigint, fees: bigint): PositionState {
  return {
    netQuantity: toBigInt(row.net_quantity_after), totalCost: toBigInt(row.total_cost_after),
    realizedPnl: realized, totalFees: fees,
  };
}

function seriesShape(w: Window, listingIds: number[]) {
  return {
    resolutionMs: w.stepMs,
    t: [] as number[],
    total: [] as string[],
    realized: [] as string[],
    unrealized: [] as string[],
    fees: [] as string[],
    listings: listingIds.map(listingId => ({
      listingId, symbol: null as string | null, total: [] as string[], netQuantity: [] as string[],
    })),
    events: [] as SeriesEvent[],
  };
}

export async function sessionSeries(client: PoolClient, sessionId: string, params: Record<string, string | undefined>, now: Date) {
  const states = await loadSessionStates(client, [sessionId], now);
  const session = (await client.query(
    'SELECT started_at, stopped_at FROM strategy.session WHERE session_id = $1', [sessionId])).rows[0];
  if (!session) return null;
  const end = session.stopped_at && session.stopped_at < now ? session.stopped_at : now;
  const start = parseTime(params.start, 'start');
  const until = parseTime(params.end, 'end');
  const w = window(
    start && start > session.started_at ? start : session.started_at,
    until && until < end ? until : end,
    params);
  const listingIds = states.map(s => s.listingId);
  const series = seriesShape(w, listingIds);
  const info = await loadListingInfo(client, listingIds);
  series.listings.forEach(l => { l.symbol = info.get(l.listingId)?.symbol ?? null; });

  // Where each listing stood when the window opens: the session's own last fill, else what it inherited.
  const atStart = (await client.query(`
    SELECT DISTINCT ON (listing_id) * FROM ledger.fill
    WHERE session_id = $1 AND source <> 'GAP' AND recorded_at <= $2 ORDER BY listing_id, fill_id DESC`,
  [sessionId, new Date(w.fromMs)])).rows as FillRow[];
  const fills = (await client.query(`
    SELECT * FROM ledger.fill WHERE session_id = $1 AND recorded_at > $2 AND recorded_at <= $3 ORDER BY fill_id`,
  [sessionId, new Date(w.fromMs), new Date(w.toMs)])).rows as FillRow[];

  const position = new Map<number, PositionState>();
  const mark = new Map<number, MarkInputs | null>();
  for (const state of states) {
    const own = atStart.find(f => f.listing_id === state.listingId);
    position.set(state.listingId, own
      ? fillPosition(own, toBigInt(own.realized_pnl_after), toBigInt(own.fees_after))
      : state.opening);
  }

  const changes = inOrder([
    ...await loadMarkChanges(client, listingIds, w),
    ...fills.map(fill => ({ timeMs: fill.recorded_at.getTime(), listingId: fill.listing_id, fill })),
  ]);
  for (const kind of ['SESSION_START', 'SESSION_STOP'] as const) {
    const at: Date | null = kind === 'SESSION_START' ? session.started_at : session.stopped_at;
    if (at && at.getTime() >= w.fromMs && at.getTime() <= w.toMs) {
      series.events.push({
        time: at.toISOString(), kind, sessionId, listingId: null, pnlImpact: null, actor: null, reason: null,
      });
    }
  }

  let next = 0;
  for (const t of pointTimes(w.fromMs, w.toMs, w.stepMs)) {
    for (; next < changes.length && changes[next].timeMs <= t; next++) {
      const change = changes[next];
      if (change.mark !== undefined) {
        mark.set(change.listingId, change.mark);
        continue;
      }
      const fill = change.fill as FillRow;
      if (fill.source !== 'VENUE') {
        series.events.push({
          time: fill.recorded_at.toISOString(), kind: fill.source, sessionId, listingId: fill.listing_id,
          pnlImpact: null, actor: fill.actor, reason: fill.reason,
        });
      }
      if (fill.source !== 'GAP') {
        position.set(fill.listing_id,
          fillPosition(fill, toBigInt(fill.realized_pnl_after), toBigInt(fill.fees_after)));
      }
    }
    let total = 0n;
    let realized = 0n;
    let unrealized = 0n;
    let fees = 0n;
    states.forEach((state, i) => {
      const p = sessionPnl({
        opening: state.opening, openingMark: state.openingMark,
        current: position.get(state.listingId) ?? FLAT, mark: mark.get(state.listingId) ?? null,
      });
      total += p.total;
      realized += p.realized;
      unrealized += p.unrealized;
      fees += p.fees;
      series.listings[i].total.push(p.total.toString());
      series.listings[i].netQuantity.push((position.get(state.listingId) ?? FLAT).netQuantity.toString());
    });
    series.t.push(t);
    series.total.push(total.toString());
    series.realized.push(realized.toString());
    series.unrealized.push(unrealized.toString());
    series.fees.push(fees.toString());
  }
  return series;
}

export async function strategySeries(
  client: PoolClient, strategyId: number, mode: string, params: Record<string, string | undefined>, now: Date,
) {
  const first = (await client.query(
    'SELECT MIN(recorded_at) AS first FROM ledger.fill WHERE strategy_id = $1 AND mode = $2', [strategyId, mode],
  )).rows[0].first as Date | null;
  const start = parseTime(params.start, 'start') ?? first ?? now;
  const until = parseTime(params.end, 'end');
  const w = window(start, until && until < now ? until : now, params);
  const from = new Date(w.fromMs);

  const state = await loadStrategyState(client, mode, strategyId, from);
  const fills = (await client.query(`
    SELECT * FROM ledger.fill
    WHERE strategy_id = $1 AND mode = $2 AND recorded_at > $3 AND recorded_at <= $4 ORDER BY fill_id`,
  [strategyId, mode, from, new Date(w.toMs)])).rows as FillRow[];
  const listingIds = [...new Set([...state.listings.map(l => l.listingId), ...fills.map(f => f.listing_id)])].sort((a, b) => a - b);
  const series = seriesShape(w, listingIds);
  const info = await loadListingInfo(client, listingIds);
  series.listings.forEach(l => { l.symbol = info.get(l.listingId)?.symbol ?? null; });

  // Per listing: the position's quantity and cost, and each session's realized PnL and fees so far.
  const position = new Map<number, PositionState>();
  const sessionTotals = new Map<string, { realized: bigint; fees: bigint }>();
  const mark = new Map<number, MarkInputs | null>();
  for (const l of state.listings) position.set(l.listingId, { ...l.position });
  for (const s of state.sessions) sessionTotals.set(`${s.sessionId}/${s.listingId}`, { realized: s.realized, fees: s.fees });

  const sessions = (await client.query(`
    SELECT session_id, started_at, stopped_at FROM strategy.session
    WHERE strategy_id = $1 AND mode = $2 AND started_at <= $4 AND (stopped_at IS NULL OR stopped_at >= $3)`,
  [strategyId, mode, from, new Date(w.toMs)])).rows;
  for (const s of sessions) {
    for (const [kind, at] of [['SESSION_START', s.started_at], ['SESSION_STOP', s.stopped_at]] as const) {
      if (at && at.getTime() >= w.fromMs && at.getTime() <= w.toMs) {
        series.events.push({
          time: at.toISOString(), kind, sessionId: s.session_id, listingId: null, pnlImpact: null, actor: null,
          reason: null,
        });
      }
    }
  }

  const listingTotal = (listingId: number) => {
    const p = position.get(listingId) ?? FLAT;
    return lifetimePnl(p, mark.get(listingId) ?? null);
  };

  const changes = inOrder([
    ...await loadMarkChanges(client, listingIds, w),
    ...fills.map(fill => ({ timeMs: fill.recorded_at.getTime(), listingId: fill.listing_id, fill })),
  ]);
  let next = 0;
  for (const t of pointTimes(w.fromMs, w.toMs, w.stepMs)) {
    for (; next < changes.length && changes[next].timeMs <= t; next++) {
      const change = changes[next];
      if (change.mark !== undefined) {
        mark.set(change.listingId, change.mark);
        continue;
      }
      const fill = change.fill as FillRow;
      if (fill.source === 'GAP') {
        series.events.push({
          time: fill.recorded_at.toISOString(), kind: 'GAP', sessionId: fill.session_id, listingId: fill.listing_id,
          pnlImpact: null, actor: fill.actor, reason: fill.reason,
        });
        continue;
      }
      const before = listingTotal(fill.listing_id).total;
      const held = position.get(fill.listing_id) ?? FLAT;
      let realized = held.realizedPnl;
      let fees = held.totalFees;
      if (fill.session_id !== null) {
        const key = `${fill.session_id}/${fill.listing_id}`;
        const prior = sessionTotals.get(key) ?? { realized: 0n, fees: 0n };
        const now = { realized: toBigInt(fill.realized_pnl_after), fees: toBigInt(fill.fees_after) };
        realized += now.realized - prior.realized;
        fees += now.fees - prior.fees;
        sessionTotals.set(key, now);
      }
      position.set(fill.listing_id, fillPosition(fill, realized, fees));
      if (fill.source === 'RESET' || fill.source === 'ADJUSTMENT') {
        series.events.push({
          time: fill.recorded_at.toISOString(), kind: fill.source, sessionId: fill.session_id,
          listingId: fill.listing_id, pnlImpact: (listingTotal(fill.listing_id).total - before).toString(),
          actor: fill.actor, reason: fill.reason,
        });
      }
    }
    let total = 0n;
    let realized = 0n;
    let unrealized = 0n;
    let fees = 0n;
    listingIds.forEach((listingId, i) => {
      const p = listingTotal(listingId);
      total += p.total;
      realized += p.realized;
      unrealized += p.unrealized;
      fees += p.fees;
      series.listings[i].total.push(p.total.toString());
      series.listings[i].netQuantity.push((position.get(listingId) ?? FLAT).netQuantity.toString());
    });
    series.t.push(t);
    series.total.push(total.toString());
    series.realized.push(realized.toString());
    series.unrealized.push(unrealized.toString());
    series.fees.push(fees.toString());
  }
  series.events.sort((a, b) => a.time.localeCompare(b.time));
  return series;
}

export async function series(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
  if (params.sessionId) {
    if (!isSessionId(params.sessionId)) throw new BadRequest('sessionId must be a session id');
    return sessionSeries(client, params.sessionId, params, now);
  }
  const strategyId = parsePositiveInt(params.strategyId);
  if (strategyId === undefined || Number.isNaN(strategyId)) {
    throw new BadRequest('sessionId, or strategyId and mode, are required');
  }
  let mode;
  try {
    mode = parseMode(params.mode);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
  if (!mode) throw new BadRequest('mode is required');
  return strategySeries(client, strategyId, mode, params, now);
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const result = await series(client, event.queryStringParameters ?? {}, new Date());
    if (result === null) return createResponse(404, { message: 'No such session' });
    return createResponse(200, result);
  } catch (error) {
    if (error instanceof BadRequest) return createResponse(400, { message: error.message });
    console.error('PnL series error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
