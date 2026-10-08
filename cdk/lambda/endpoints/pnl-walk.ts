import { PoolClient } from 'pg';
import { MarkInputs, PositionState, toBigInt } from './ledger-math';
import { lifetimePnl } from './pnl-math';
import { FLAT, loadStrategyState, toMark } from './pnl-state';

// Walks the ledger forward through a window, applying fills and marks in time order, and records the PnL at each of
// the given moments. Every PnL-over-time view (a strategy's chart, the firm's chart with each strategy's line, the
// daily bars) is one walk, so they can never disagree.

export interface Change {
  timeMs: number;
  listingId: number;
  mark?: MarkInputs | null;
  fill?: FillRow;
}

export interface FillRow {
  fill_id: string;
  source: string;
  session_id: string | null;
  strategy_id: number;
  listing_id: number;
  recorded_at: Date;
  net_quantity_after: string;
  total_cost_after: string;
  realized_pnl_after: string | null;
  fees_after: string | null;
  actor: string | null;
  reason: string | null;
}

export interface SeriesEvent {
  time: string;
  kind: string;
  sessionId: string | null;
  listingId: number | null;
  pnlImpact: string | null;
  actor: string | null;
  reason: string | null;
}

// Each listing's last mark at or before the window opens, then the last mark in each step inside it.
export async function loadMarkChanges(
  client: PoolClient, listingIds: number[], fromMs: number, toMs: number, stepMs: number,
): Promise<Change[]> {
  if (listingIds.length === 0) return [];
  const rows = (await client.query(`
    (SELECT DISTINCT ON (listing_id) listing_id, ts, bid, ask, last_trade FROM ledger.mark
     WHERE listing_id = ANY($1::int[]) AND ts <= $2 ORDER BY listing_id, ts DESC)
    UNION ALL
    (SELECT DISTINCT ON (listing_id, date_bin($4::interval, ts, 'epoch'::timestamptz))
       listing_id, ts, bid, ask, last_trade
     FROM ledger.mark WHERE listing_id = ANY($1::int[]) AND ts > $2 AND ts <= $3
     ORDER BY listing_id, date_bin($4::interval, ts, 'epoch'::timestamptz), ts DESC)`,
  [listingIds, new Date(fromMs), new Date(toMs), `${stepMs} milliseconds`])).rows;
  return rows.map(r => ({ timeMs: Math.max(fromMs, r.ts.getTime()), listingId: r.listing_id, mark: toMark(r) }));
}

export function inOrder(changes: Change[]): Change[] {
  // Fills before marks at the same moment, and fills in the order they were booked.
  return changes.sort((a, b) => a.timeMs - b.timeMs
    || Number(Boolean(a.mark !== undefined)) - Number(Boolean(b.mark !== undefined))
    || Number(BigInt(a.fill?.fill_id ?? 0) - BigInt(b.fill?.fill_id ?? 0)));
}

export function fillPosition(row: FillRow, realized: bigint, fees: bigint): PositionState {
  return {
    netQuantity: toBigInt(row.net_quantity_after), totalCost: toBigInt(row.total_cost_after),
    realizedPnl: realized, totalFees: fees,
  };
}

export interface LifetimeWalkOptions {
  mode: string;
  // One strategy, or every strategy in the mode.
  strategyId: number | null;
  // One listing, or all of them.
  listingId?: number;
  fromMs: number;
  toMs: number;
  // Marks are read as the last in each bin of this width; a point sees the bins that ended before it.
  markStepMs: number;
  times: number[];
  sessionEvents: boolean;
}

export interface LifetimeWalk {
  // One per strategy and listing traded, in (strategy, listing) order.
  keys: { strategyId: number; listingId: number }[];
  t: number[];
  total: bigint[];
  realized: bigint[];
  unrealized: bigint[];
  fees: bigint[];
  // [key][point]
  keyTotal: bigint[][];
  keyNet: bigint[][];
  events: SeriesEvent[];
}

// Lifetime PnL (see pnl-math): each session's realized PnL and fees summed, plus the unrealized PnL of the position
// held, valued at the mark at that moment.
export async function walkLifetime(client: PoolClient, options: LifetimeWalkOptions): Promise<LifetimeWalk> {
  const { mode, strategyId, fromMs, toMs } = options;
  const from = new Date(fromMs);
  const loaded = await loadStrategyState(client, mode, strategyId, from);
  const onListing = <T extends { listingId: number }>(rows: T[]) =>
    options.listingId === undefined ? rows : rows.filter(r => r.listingId === options.listingId);
  const state = { listings: onListing(loaded.listings), sessions: onListing(loaded.sessions) };
  const fills = (await client.query(`
    SELECT * FROM ledger.fill
    WHERE mode = $1 AND ($2::int IS NULL OR strategy_id = $2) AND ($5::int IS NULL OR listing_id = $5)
      AND recorded_at > $3 AND recorded_at <= $4
    ORDER BY fill_id`, [mode, strategyId, from, new Date(toMs), options.listingId ?? null])).rows as FillRow[];

  const keyOf = (s: number, l: number) => `${s}/${l}`;
  const keyed = new Map<string, { strategyId: number; listingId: number }>();
  for (const l of state.listings) keyed.set(keyOf(l.strategyId, l.listingId), { strategyId: l.strategyId, listingId: l.listingId });
  for (const f of fills) keyed.set(keyOf(f.strategy_id, f.listing_id), { strategyId: f.strategy_id, listingId: f.listing_id });
  const keys = [...keyed.values()].sort((a, b) => a.strategyId - b.strategyId || a.listingId - b.listingId);

  const position = new Map<string, PositionState>();
  const sessionTotals = new Map<string, { realized: bigint; fees: bigint }>();
  const mark = new Map<number, MarkInputs | null>();
  for (const l of state.listings) position.set(keyOf(l.strategyId, l.listingId), { ...l.position });
  for (const s of state.sessions) sessionTotals.set(`${s.sessionId}/${s.listingId}`, { realized: s.realized, fees: s.fees });

  const walk: LifetimeWalk = {
    keys, t: [], total: [], realized: [], unrealized: [], fees: [],
    keyTotal: keys.map(() => []), keyNet: keys.map(() => []), events: [],
  };

  if (options.sessionEvents) {
    const sessions = (await client.query(`
      SELECT session_id, started_at, stopped_at FROM strategy.session
      WHERE mode = $1 AND ($2::int IS NULL OR strategy_id = $2) AND started_at <= $4
        AND (stopped_at IS NULL OR stopped_at >= $3)`,
    [mode, strategyId, from, new Date(toMs)])).rows;
    for (const s of sessions) {
      for (const [kind, at] of [['SESSION_START', s.started_at], ['SESSION_STOP', s.stopped_at]] as const) {
        if (at && at.getTime() >= fromMs && at.getTime() <= toMs) {
          walk.events.push({
            time: at.toISOString(), kind, sessionId: s.session_id, listingId: null, pnlImpact: null, actor: null,
            reason: null,
          });
        }
      }
    }
  }

  const valued = (key: { strategyId: number; listingId: number }) =>
    lifetimePnl(position.get(keyOf(key.strategyId, key.listingId)) ?? FLAT, mark.get(key.listingId) ?? null);

  const listingIds = [...new Set(keys.map(k => k.listingId))];
  const changes = inOrder([
    ...await loadMarkChanges(client, listingIds, fromMs, toMs, options.markStepMs),
    ...fills.map(fill => ({ timeMs: fill.recorded_at.getTime(), listingId: fill.listing_id, fill })),
  ]);
  let next = 0;
  for (const t of options.times) {
    for (; next < changes.length && changes[next].timeMs <= t; next++) {
      const change = changes[next];
      if (change.mark !== undefined) {
        mark.set(change.listingId, change.mark);
        continue;
      }
      const fill = change.fill as FillRow;
      if (fill.source === 'GAP') {
        walk.events.push({
          time: fill.recorded_at.toISOString(), kind: 'GAP', sessionId: fill.session_id, listingId: fill.listing_id,
          pnlImpact: null, actor: fill.actor, reason: fill.reason,
        });
        continue;
      }
      const key = { strategyId: fill.strategy_id, listingId: fill.listing_id };
      const before = valued(key).total;
      const held = position.get(keyOf(key.strategyId, key.listingId)) ?? FLAT;
      let realized = held.realizedPnl;
      let fees = held.totalFees;
      if (fill.session_id !== null) {
        const sessionKey = `${fill.session_id}/${fill.listing_id}`;
        const prior = sessionTotals.get(sessionKey) ?? { realized: 0n, fees: 0n };
        const after = { realized: toBigInt(fill.realized_pnl_after), fees: toBigInt(fill.fees_after) };
        realized += after.realized - prior.realized;
        fees += after.fees - prior.fees;
        sessionTotals.set(sessionKey, after);
      } else if (fill.source === 'MANUAL' || fill.source === 'SETTLEMENT') {
        realized += toBigInt(fill.realized_pnl_after);
        fees += toBigInt(fill.fees_after);
      }
      position.set(keyOf(key.strategyId, key.listingId), fillPosition(fill, realized, fees));
      if (fill.source === 'RESET' || fill.source === 'ADJUSTMENT' || fill.source === 'MANUAL'
        || fill.source === 'SETTLEMENT') {
        walk.events.push({
          time: fill.recorded_at.toISOString(), kind: fill.source, sessionId: fill.session_id,
          listingId: fill.listing_id, pnlImpact: (valued(key).total - before).toString(),
          actor: fill.actor, reason: fill.reason,
        });
      }
    }
    let total = 0n;
    let realized = 0n;
    let unrealized = 0n;
    let fees = 0n;
    keys.forEach((key, i) => {
      const p = valued(key);
      total += p.total;
      realized += p.realized;
      unrealized += p.unrealized;
      fees += p.fees;
      walk.keyTotal[i].push(p.total);
      walk.keyNet[i].push((position.get(keyOf(key.strategyId, key.listingId)) ?? FLAT).netQuantity);
    });
    walk.t.push(t);
    walk.total.push(total);
    walk.realized.push(realized);
    walk.unrealized.push(unrealized);
    walk.fees.push(fees);
  }
  walk.events.sort((a, b) => a.time.localeCompare(b.time));
  return walk;
}
