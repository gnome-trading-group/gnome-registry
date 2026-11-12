import { PoolClient } from 'pg';
import { MarkInputs, PositionState, pricedMark, toBigInt } from './ledger-math';
import { lifetimePnl } from './pnl-math';
import { FLAT, loadRewards, loadStrategyState, toMark } from './pnl-state';

// Walks the ledger forward through a window, applying fills and marks in time order, and records the PnL at each of
// the given moments. Every PnL-over-time view (a strategy's chart, the firm's chart with each strategy's line, the
// daily bars) is one walk, so they can never disagree. Venue rewards step a strategy's PnL up when they were paid;
// over the whole firm, so does the non-trading money that stays the firm's. Neither is on a listing's own walk.

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
  account_id: number | null;
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
     WHERE listing_id = ANY($1::int[]) AND ts <= $2 AND ${pricedMark()} ORDER BY listing_id, ts DESC)
    UNION ALL
    (SELECT DISTINCT ON (listing_id, date_bin($4::interval, ts, 'epoch'::timestamptz))
       listing_id, ts, bid, ask, last_trade
     FROM ledger.mark WHERE listing_id = ANY($1::int[]) AND ts > $2 AND ts <= $3 AND ${pricedMark()}
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
  // Listings walked point by point even if dormant in the window, as a chart already drawing their lines needs them.
  keepListingIds?: number[];
}

export interface LifetimeWalk {
  // One per strategy and listing active in the window (held at some point, or traded), in (strategy, listing) order.
  keys: { strategyId: number; listingId: number }[];
  // Every strategy with anything on the ledger by the window's end, and the PnL of each one's dormant listings: flat
  // through the whole window and untraded in it, so worth their realized PnL less fees at every point.
  strategyIds: number[];
  dormantTotal: Map<number, bigint>;
  t: number[];
  total: bigint[];
  realized: bigint[];
  unrealized: bigint[];
  fees: bigint[];
  // [key][point]
  keyTotal: bigint[][];
  keyNet: bigint[][];
  // [point]: each strategy's rewards so far, and (firm-wide walks only) the firm's own non-trading PnL so far.
  rewards: Map<number, bigint[]>;
  nonTrading: bigint[];
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

  // A strategy's listing is one key of the walk, held as one position per venue account (each valued on its own
  // and summed, since an account's cost basis can't be merged with another's).
  const keyOf = (s: number, l: number) => `${s}/${l}`;
  const positionKeyOf = (s: number, l: number, a: number | null) => `${s}/${l}/${a ?? ''}`;
  const keyed = new Map<string, { strategyId: number; listingId: number }>();
  const accountsOf = new Map<string, Set<string>>();
  const hold = (s: number, l: number, a: number | null) => {
    keyed.set(keyOf(s, l), { strategyId: s, listingId: l });
    const held = accountsOf.get(keyOf(s, l)) ?? new Set<string>();
    held.add(positionKeyOf(s, l, a));
    accountsOf.set(keyOf(s, l), held);
  };
  for (const l of state.listings) hold(l.strategyId, l.listingId, l.accountId);
  for (const f of fills) hold(f.strategy_id, f.listing_id, f.account_id);

  const position = new Map<string, PositionState>();
  const sessionTotals = new Map<string, { realized: bigint; fees: bigint }>();
  const mark = new Map<number, MarkInputs | null>();
  for (const l of state.listings) position.set(positionKeyOf(l.strategyId, l.listingId, l.accountId), { ...l.position });
  for (const s of state.sessions) sessionTotals.set(`${s.sessionId}/${s.listingId}`, { realized: s.realized, fees: s.fees });

  // Most of what a strategy has traded is long flat: valuing it at every point would make each walk grow with every
  // listing ever traded, while its PnL can't move until it trades again.
  const traded = new Set(fills.map(f => keyOf(f.strategy_id, f.listing_id)));
  const keep = new Set(options.keepListingIds ?? []);
  const dormant = { total: 0n, realized: 0n, fees: 0n };
  const dormantTotal = new Map<number, bigint>();
  const keys: { strategyId: number; listingId: number }[] = [];
  for (const key of [...keyed.values()].sort((a, b) => a.strategyId - b.strategyId || a.listingId - b.listingId)) {
    const held = [...accountsOf.get(keyOf(key.strategyId, key.listingId)) ?? []];
    const flat = held.every(h => (position.get(h) ?? FLAT).netQuantity === 0n);
    if (!flat || traded.has(keyOf(key.strategyId, key.listingId)) || keep.has(key.listingId)) {
      keys.push(key);
      continue;
    }
    for (const h of held) {
      const p = lifetimePnl(position.get(h) ?? FLAT, null);
      dormant.total += p.total;
      dormant.realized += p.realized;
      dormant.fees += p.fees;
      dormantTotal.set(key.strategyId, (dormantTotal.get(key.strategyId) ?? 0n) + p.total);
    }
  }

  // A listing's own line is its trading PnL, as its summary row is; rewards step only strategy and firm lines.
  const rewardRows = options.listingId !== undefined ? []
    : await loadRewards(client, mode, { strategyId, firm: strategyId === null }, new Date(toMs));
  const rewardStrategies = rewardRows.flatMap(r => (r.strategyId === null ? [] : [r.strategyId]));
  const strategyIds = [...new Set([...[...keyed.values()].map(k => k.strategyId), ...rewardStrategies])].sort((a, b) => a - b);
  const walk: LifetimeWalk = {
    keys, strategyIds, dormantTotal,
    t: [], total: [], realized: [], unrealized: [], fees: [],
    keyTotal: keys.map(() => []), keyNet: keys.map(() => []),
    rewards: new Map([...new Set(rewardStrategies)].map(id => [id, []])), nonTrading: [], events: [],
  };
  for (const r of rewardRows) {
    if (r.occurredAt.getTime() <= fromMs) continue;
    walk.events.push({
      time: r.occurredAt.toISOString(), kind: r.strategyId === null ? 'NON_TRADING' : 'REWARD', sessionId: null,
      listingId: r.listingId, pnlImpact: r.amount.toString(), actor: null, reason: `${r.exchangeCode} ${r.program}`,
    });
  }

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

  const valued = (key: { strategyId: number; listingId: number }) => {
    const sum = { total: 0n, realized: 0n, unrealized: 0n, fees: 0n };
    for (const held of accountsOf.get(keyOf(key.strategyId, key.listingId)) ?? []) {
      const p = lifetimePnl(position.get(held) ?? FLAT, mark.get(key.listingId) ?? null);
      sum.total += p.total;
      sum.realized += p.realized;
      sum.unrealized += p.unrealized;
      sum.fees += p.fees;
    }
    return sum;
  };
  const netOf = (key: { strategyId: number; listingId: number }) => [...accountsOf.get(keyOf(key.strategyId, key.listingId)) ?? []]
    .reduce((net, held) => net + (position.get(held) ?? FLAT).netQuantity, 0n);

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
      const heldKey = positionKeyOf(fill.strategy_id, fill.listing_id, fill.account_id);
      const before = valued(key).total;
      const held = position.get(heldKey) ?? FLAT;
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
      position.set(heldKey, fillPosition(fill, realized, fees));
      if (fill.source === 'RESET' || fill.source === 'ADJUSTMENT' || fill.source === 'MANUAL'
        || fill.source === 'SETTLEMENT') {
        walk.events.push({
          time: fill.recorded_at.toISOString(), kind: fill.source, sessionId: fill.session_id,
          listingId: fill.listing_id, pnlImpact: (valued(key).total - before).toString(),
          actor: fill.actor, reason: fill.reason,
        });
      }
    }
    let total = dormant.total;
    let realized = dormant.realized;
    let unrealized = 0n;
    let fees = dormant.fees;
    keys.forEach((key, i) => {
      const p = valued(key);
      total += p.total;
      realized += p.realized;
      unrealized += p.unrealized;
      fees += p.fees;
      walk.keyTotal[i].push(p.total);
      walk.keyNet[i].push(netOf(key));
    });
    let rewarded = 0n;
    for (const [id, line] of walk.rewards) {
      const sum = rewardRows.reduce((acc, r) => (r.strategyId === id && r.occurredAt.getTime() <= t ? acc + r.amount : acc), 0n);
      line.push(sum);
      rewarded += sum;
    }
    const firmOnly = rewardRows.reduce((acc, r) => (r.strategyId === null && r.occurredAt.getTime() <= t ? acc + r.amount : acc), 0n);
    walk.nonTrading.push(firmOnly);
    total += rewarded + firmOnly;
    walk.t.push(t);
    walk.total.push(total);
    walk.realized.push(realized);
    walk.unrealized.push(unrealized);
    walk.fees.push(fees);
  }
  walk.events.sort((a, b) => a.time.localeCompare(b.time));
  return walk;
}

// One strategy's lifetime PnL at each point of a walk: its active listings', its dormant ones' and its rewards.
export function strategyTotals(walk: LifetimeWalk, strategyId: number): bigint[] {
  const base = walk.dormantTotal.get(strategyId) ?? 0n;
  const own = walk.keys.flatMap((key, k) => (key.strategyId === strategyId ? [walk.keyTotal[k]] : []));
  const rewards = walk.rewards.get(strategyId);
  return walk.t.map((_, p) => own.reduce((sum, line) => sum + line[p], base + (rewards?.[p] ?? 0n)));
}
