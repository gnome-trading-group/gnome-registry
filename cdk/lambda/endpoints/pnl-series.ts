import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId, parseMode, parsePositiveInt } from './ledger-common';
import { MarkInputs, PositionState, toBigInt } from './ledger-math';
import { pickResolution, pointTimes, sessionPnl } from './pnl-math';
import { FLAT, loadListingInfo, loadSessionStates } from './pnl-state';
import { FillRow, fillPosition, inOrder, loadMarkChanges, SeriesEvent, strategyTotals, walkLifetime } from './pnl-walk';

// PnL over time for a chart, one point per resolution step (the smallest that keeps the series within a bounded
// number of points), each the state at that moment: the position the newest fill left, valued at the newest mark.
//   ?sessionId=            the session's PnL since it started (it starts at $0; see pnl-math)
//   ?strategyId=&mode=     the strategy's lifetime PnL, continuous across its sessions (&listingId= for one listing)
//   ?mode=                 every strategy's: the firm's lifetime PnL, with each strategy's line
// Optional: start, end (ISO), resolution (ms), since (ms; only points from then on, for appending to a chart).
// Each listing's own line, as long as the series, comes only when asked for, so a strategy trading many listings
// can't outgrow the response:
//   byListing=true         the MAX_SERIES_LISTINGS listings that moved most over the window, among those held or traded
//                          in it, with listingCount (how many were) and `other`, everything else summed
//   listingIds=1,2         exactly these lines (and `other`): a poll keeps the lines its chart already draws
//   listingId= (strategy)  that listing alone; implies its line
// Every listing is carried forward between its own updates, so the totals always equal the lines plus `other`.

export const MAX_SERIES_LISTINGS = 25;

class BadRequest extends Error {}

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

function parseListingIds(value: string | undefined): number[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(',').map(Number);
  if (ids.length > MAX_SERIES_LISTINGS || ids.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new BadRequest(`listingIds must be 1 to ${MAX_SERIES_LISTINGS} positive integers`);
  }
  return ids;
}

function seriesShape(w: Window) {
  return {
    resolutionMs: w.stepMs,
    t: [] as number[],
    total: [] as string[],
    realized: [] as string[],
    unrealized: [] as string[],
    fees: [] as string[],
    listings: [] as { listingId: number; symbol: string | null; lotSize: string | null; total: string[]; netQuantity: string[] }[],
    listingCount: 0,
    other: null as string[] | null,
    events: [] as SeriesEvent[],
  };
}

interface Line {
  listingId: number;
  total: bigint[];
  net: bigint[];
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const moved = (line: Line) => abs((line.total.at(-1) ?? 0n) - (line.total[0] ?? 0n));

// Draws the chosen lines into the series: those asked for by id, else the ones that moved most. `active` are the
// lines held or traded in the window; whatever isn't drawn, dormant listings included, goes into `other`.
async function drawLines(
  client: PoolClient, series: ReturnType<typeof seriesShape>, active: Line[], total: bigint[], requested?: number[],
) {
  const shown = requested
    ? requested.flatMap(id => active.filter(l => l.listingId === id))
    : [...active].sort((a, b) => (moved(a) === moved(b) ? a.listingId - b.listingId : moved(b) > moved(a) ? 1 : -1))
      .slice(0, MAX_SERIES_LISTINGS);
  const info = await loadListingInfo(client, shown.map(l => l.listingId));
  series.listings = shown.map(l => ({
    listingId: l.listingId,
    symbol: info.get(l.listingId)?.symbol ?? null,
    lotSize: info.get(l.listingId)?.lotSize ?? null,
    total: l.total.map(String),
    netQuantity: l.net.map(String),
  }));
  series.listingCount = active.length;
  series.other = total.map((value, p) => shown.reduce((rest, l) => rest - l.total[p], value).toString());
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
  const requested = parseListingIds(params.listingIds);
  const byListing = params.byListing === 'true' || requested !== undefined;
  const listingIds = states.map(s => s.listingId);
  const series = seriesShape(w);

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
  const ownAtStart = new Map(atStart.map(f => [f.listing_id, f]));
  for (const state of states) {
    const own = ownAtStart.get(state.listingId);
    position.set(state.listingId, own
      ? fillPosition(own, toBigInt(own.realized_pnl_after), toBigInt(own.fees_after))
      : state.opening);
  }

  const changes = inOrder([
    ...await loadMarkChanges(client, listingIds, w.fromMs, w.toMs, w.stepMs),
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

  const lines: Line[] = states.map(s => ({ listingId: s.listingId, total: [], net: [] }));
  const totals: bigint[] = [];
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
      if (byListing) {
        lines[i].total.push(p.total);
        lines[i].net.push((position.get(state.listingId) ?? FLAT).netQuantity);
      }
    });
    totals.push(total);
    series.t.push(t);
    series.total.push(total.toString());
    series.realized.push(realized.toString());
    series.unrealized.push(unrealized.toString());
    series.fees.push(fees.toString());
  }
  if (byListing) {
    const traded = new Set(fills.map(f => f.listing_id));
    const active = lines.filter(l => traded.has(l.listingId) || l.net.some(n => n !== 0n) || requested?.includes(l.listingId));
    await drawLines(client, series, active, totals, requested);
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
  const listingId = parsePositiveInt(params.listingId);
  if (Number.isNaN(listingId)) throw new BadRequest('listingId must be a positive integer');
  const requested = listingId === undefined ? parseListingIds(params.listingIds) : [listingId];
  const walk = await walkLifetime(client, {
    mode, strategyId, listingId, fromMs: w.fromMs, toMs: w.toMs, markStepMs: w.stepMs,
    times: pointTimes(w.fromMs, w.toMs, w.stepMs), sessionEvents: true, keepListingIds: requested,
  });
  const series = seriesShape(w);
  if (params.byListing === 'true' || requested !== undefined) {
    const active = walk.keys.map((key, k) => ({ listingId: key.listingId, total: walk.keyTotal[k], net: walk.keyNet[k] }));
    await drawLines(client, series, active, walk.total, requested);
  }
  series.t = walk.t;
  series.total = walk.total.map(String);
  series.realized = walk.realized.map(String);
  series.unrealized = walk.unrealized.map(String);
  series.fees = walk.fees.map(String);
  series.events = walk.events;
  return series;
}

// Every strategy in a mode: the firm's lifetime PnL, and each strategy's own line (for sparklines).
export async function firmSeries(client: PoolClient, mode: string, params: Record<string, string | undefined>, now: Date) {
  const first = (await client.query(
    'SELECT MIN(recorded_at) AS first FROM ledger.fill WHERE mode = $1', [mode])).rows[0].first as Date | null;
  const start = parseTime(params.start, 'start') ?? first ?? now;
  const until = parseTime(params.end, 'end');
  const w = window(start, until && until < now ? until : now, params);
  const walk = await walkLifetime(client, {
    mode, strategyId: null, fromMs: w.fromMs, toMs: w.toMs, markStepMs: w.stepMs,
    times: pointTimes(w.fromMs, w.toMs, w.stepMs), sessionEvents: false,
  });
  return {
    resolutionMs: w.stepMs,
    t: walk.t,
    total: walk.total.map(String),
    realized: walk.realized.map(String),
    unrealized: walk.unrealized.map(String),
    fees: walk.fees.map(String),
    listings: [],
    listingCount: 0,
    other: null,
    events: walk.events,
    strategies: walk.strategyIds.map(strategyId => ({
      strategyId, total: strategyTotals(walk, strategyId).map(String),
    })),
  };
}

export async function series(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
  if (params.sessionId) {
    if (!isSessionId(params.sessionId)) throw new BadRequest('sessionId must be a session id');
    return sessionSeries(client, params.sessionId, params, now);
  }
  const strategyId = parsePositiveInt(params.strategyId);
  if (Number.isNaN(strategyId)) throw new BadRequest('strategyId must be a positive integer');
  let mode;
  try {
    mode = parseMode(params.mode);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
  if (!mode) throw new BadRequest('mode is required');
  return strategyId === undefined
    ? firmSeries(client, mode, params, now)
    : strategySeries(client, strategyId, mode, params, now);
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
