import { PoolClient } from 'pg';
import { toBigInt } from './ledger-math';
import { BROKEN_DOWN_BY_VENUE, DAY_MS, payoutDay } from '../sync/venues/types';

// Gives each venue reward to the live strategies that earned it. A venue pays the account, and for most programs says
// what each market earned (Polymarket's per-market endpoints, the ticker in a Kalshi credit); the strategies that
// quoted or traded those markets on the account then split each market's part:
//   LIQUIDITY     paid for resting quotes: by resting size × time
//   MAKER_REBATE  a share of fees on maker fills: by maker fills' fee-equivalent, qty × p(1 − p), else resting time
//   TAKER_REBATE  a share of the taker fees paid, account-wide: by taker fees
// A part no strategy of ours earned stays the firm's, listed on the transfer (PARTIAL, or FAILED when that's all of
// it). A payout whose breakdown hasn't come is retried each poll, then left to the firm after WAIT_MS.

export interface BreakdownMarket {
  venueMarket: string;
  amount: string;
  from: string;
  to: string;
  // The venue program's own period, where it defines one; the instants bounding it.
  periodStart?: string | null;
  periodEnd?: string | null;
}

export interface BreakdownInput {
  externalRef: string;
  markets: BreakdownMarket[];
  // Other readings of the same payout to try when markets doesn't add up to it (a Polymarket reward with or without
  // its sponsored part).
  alternatives?: BreakdownMarket[][];
  // markets lists everything earned that may still be unpaid, oldest first by period: the payout is its oldest days
  // not already paid, up to the day where they add up to it (Polymarket US pays days late, in arrears).
  inArrears?: boolean;
}

interface Part {
  venueMarket: string | null;
  amount: bigint;
  from: Date;
  to: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
}

interface Account {
  account_id: number;
  exchange_code: string;
}

const HOUR_MS = 3_600_000;
const WAIT_MS = 10 * DAY_MS;
// The venue's per-market amounts are rounded; a breakdown is the payout's if it adds up to it within this.
const TOLERANCE = 10_000_000n;
// Kalshi pays a liquidity period in a run the morning after it closes; its periods are mostly a day.
const KALSHI_PERIOD_MS = 48 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// Splits amount in proportion to weights, the remainder going to the largest fractional parts, so the parts add up
// to it exactly.
export function split(amount: bigint, weights: bigint[]): bigint[] {
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total <= 0n) return weights.map(() => 0n);
  const parts = weights.map(w => (amount * w) / total);
  let left = amount - parts.reduce((a, b) => a + b, 0n);
  const order = weights.map((w, i) => ({ i, rest: (amount * w) % total }))
    .sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.i - b.i));
  for (const { i } of order) {
    if (left === 0n) break;
    parts[i] += 1n;
    left -= 1n;
  }
  return parts;
}

const within = (a: bigint, b: bigint) => a - b <= TOLERANCE && b - a <= TOLERANCE;

function toPart(m: BreakdownMarket, amount: bigint): Part {
  return {
    venueMarket: m.venueMarket, amount, from: new Date(m.from), to: new Date(m.to),
    periodStart: m.periodStart ? new Date(m.periodStart) : null, periodEnd: m.periodEnd ? new Date(m.periodEnd) : null,
  };
}

// The markets of a breakdown that make up a payout, scaled so they add up to it exactly; null when they don't.
export function matchBreakdown(markets: BreakdownMarket[], amount: bigint, inArrears: boolean): Part[] | null {
  let chosen = markets;
  if (inArrears) {
    // Oldest period first, whole periods at a time, until they add up to the payout.
    const periods = [...new Set(markets.map(m => m.periodStart ?? m.from))].sort();
    chosen = [];
    let sum = 0n;
    let found = false;
    for (const period of periods) {
      const these = markets.filter(m => (m.periodStart ?? m.from) === period);
      chosen.push(...these);
      sum += these.reduce((s, m) => s + BigInt(m.amount), 0n);
      if (within(sum, amount)) {
        found = true;
        break;
      }
      if (sum > amount + TOLERANCE) break;
    }
    if (!found) return null;
  }
  const total = chosen.reduce((s, m) => s + BigInt(m.amount), 0n);
  if (chosen.length === 0 || total <= 0n || !within(total, amount)) return null;
  const shares = split(amount, chosen.map(m => BigInt(m.amount)));
  return chosen.map((m, i) => toPart(m, shares[i]));
}

// The time a payout was earned over, where the venue doesn't say.
function earnedOver(exchangeCode: string, program: string, occurredAt: Date): { from: Date; to: Date } {
  if (exchangeCode === 'POLYMARKET_INTL') {
    const day = payoutDay(occurredAt);
    return { from: day, to: new Date(day.getTime() + DAY_MS) };
  }
  const span = program === 'LIQUIDITY' ? KALSHI_PERIOD_MS : WEEK_MS;
  return { from: new Date(occurredAt.getTime() - span), to: occurredAt };
}

type Plan = Part[] | { wait: true } | { failed: string };

async function plan(
  client: PoolClient, t: Record<string, any>, account: Account, breakdown: BreakdownInput | undefined, now: Date,
): Promise<Plan> {
  const occurredAt: Date = t.occurred_at;
  const amount = toBigInt(t.amount);
  const window = earnedOver(account.exchange_code, t.program, occurredAt);
  const unperiod = { periodStart: null, periodEnd: null };
  if (t.program === 'TAKER_REBATE') return [{ venueMarket: null, amount, ...window, ...unperiod }];
  if ((BROKEN_DOWN_BY_VENUE[account.exchange_code] ?? []).includes(t.program)) {
    if (breakdown) {
      // Periods an earlier payout of the same program already paid, given out or left to the firm, aren't paid again.
      const paid = new Set((await client.query(
        `SELECT al.venue_market, al.period_start FROM treasury.transfer_allocation al
         JOIN treasury.transfer t ON t.transfer_id = al.transfer_id
         WHERE t.account_id = $1 AND t.program = $2 AND al.period_start IS NOT NULL
         UNION
         SELECT u->>'venueMarket', (u->>'periodStart')::timestamptz FROM treasury.transfer t,
           jsonb_array_elements(t.unallocated) u
         WHERE t.account_id = $1 AND t.program = $2 AND u->>'periodStart' IS NOT NULL`,
        [account.account_id, t.program])).rows.map(r => `${r.venue_market}@${r.period_start.toISOString()}`));
      const unpaid = (markets: BreakdownMarket[]) => markets.filter(m =>
        !m.periodStart || !paid.has(`${m.venueMarket}@${new Date(m.periodStart).toISOString()}`));
      for (const markets of [breakdown.markets, ...(breakdown.alternatives ?? [])]) {
        const parts = matchBreakdown(unpaid(markets), amount, breakdown.inArrears === true);
        if (parts) return parts;
      }
    }
    return now.getTime() - occurredAt.getTime() > WAIT_MS
      ? { failed: 'the venue\'s per-market breakdown never added up to the payout' } : { wait: true };
  }
  if (t.venue_market) return [{ venueMarket: t.venue_market, amount, ...window, ...unperiod }];
  return { failed: 'the venue named no market for it' };
}

interface Weight {
  strategyId: number;
  listingId: number | null;
  weight: bigint;
}

// A Kalshi credit may name the event rather than the market; the event's markets all start with its ticker.
const MARKET_FILTER = `($3::text IS NULL OR split_part(l.exchange_security_id, ':', 1) = $3
  OR ($5::boolean AND split_part(l.exchange_security_id, ':', 1) LIKE $3 || '-%'))`;
// When a fill happened on the venue; a fill booked without one counts when it was recorded.
const FILL_TIME = `CASE WHEN f.event_time_ns > 0 THEN to_timestamp(f.event_time_ns / 1e9) ELSE f.recorded_at END`;

async function weights(client: PoolClient, account: Account, program: string, part: Part, now: Date, basis: string): Promise<Weight[]> {
  const args = [account.account_id, part.from, part.venueMarket, part.to, account.exchange_code === 'KALSHI'];
  let rows;
  if (basis === 'RESTING_TIME') {
    // An order's size, though fills shrink it: the ledger keeps no history of an order's resting size.
    rows = (await client.query(
      `SELECT o.strategy_id, o.listing_id,
         FLOOR(SUM(o.size::numeric * EXTRACT(EPOCH FROM
           LEAST(COALESCE(o.closed_at, $6::timestamptz), $4::timestamptz)
           - GREATEST(COALESCE(o.acked_at, o.opened_at), $2::timestamptz))))::text AS weight
       FROM ledger.order o JOIN sm.listing l ON l.listing_id = o.listing_id
       WHERE o.account_id = $1 AND o.mode = 'live' AND o.size IS NOT NULL
         AND COALESCE(o.acked_at, o.opened_at) < $4 AND COALESCE(o.closed_at, $6::timestamptz) > $2 AND ${MARKET_FILTER}
       GROUP BY o.strategy_id, o.listing_id`, [...args, now])).rows;
  } else {
    const measure = basis === 'MAKER_FILLS'
      ? `f.fill_qty::numeric * f.fill_price * (${1_000_000_000} - f.fill_price)` : 'f.fee::numeric';
    const liquidity = basis === 'MAKER_FILLS' ? 'MAKER' : 'TAKER';
    rows = (await client.query(
      `SELECT f.strategy_id, f.listing_id, FLOOR(SUM(${measure}))::text AS weight
       FROM ledger.fill f JOIN sm.listing l ON l.listing_id = f.listing_id
       WHERE f.account_id = $1 AND f.mode = 'live' AND f.source = 'VENUE' AND f.liquidity = '${liquidity}'
         AND ${FILL_TIME} >= $2 AND ${FILL_TIME} < $4 AND ${MARKET_FILTER}
       GROUP BY f.strategy_id, f.listing_id`, args)).rows;
  }
  // One weight per strategy, on the listing it earned most on; a taker rebate is the account's, not a listing's.
  const byStrategy = new Map<number, Weight & { best: bigint }>();
  for (const r of rows) {
    const w = BigInt(r.weight ?? '0');
    if (w <= 0n) continue;
    const entry = byStrategy.get(r.strategy_id) ?? { strategyId: r.strategy_id, listingId: null, weight: 0n, best: 0n };
    entry.weight += w;
    if (w > entry.best && program !== 'TAKER_REBATE') {
      entry.best = w;
      entry.listingId = r.listing_id;
    }
    byStrategy.set(r.strategy_id, entry);
  }
  return [...byStrategy.values()].sort((a, b) => a.strategyId - b.strategyId);
}

// The ways to split a market's part between strategies, tried in order until one finds any.
const BASES: Record<string, string[]> = {
  LIQUIDITY: ['RESTING_TIME'],
  MAKER_REBATE: ['MAKER_FILLS', 'RESTING_TIME'],
  TAKER_REBATE: ['TAKER_FEES'],
};

// Allocates the account's PENDING rewards it can, in the caller's transaction; returns how many it settled. The rows
// are locked, so two readings of the account can't allocate one reward twice.
export async function allocatePending(client: PoolClient, account: Account, breakdowns: BreakdownInput[], now: Date): Promise<number> {
  const pending = (await client.query(
    `SELECT transfer_id, external_ref, program, amount, occurred_at, venue_market FROM treasury.transfer
     WHERE account_id = $1 AND allocation_state = 'PENDING' ORDER BY occurred_at, transfer_id FOR UPDATE`,
  [account.account_id])).rows;
  const byRef = new Map(breakdowns.map(b => [b.externalRef, b]));
  let settled = 0;
  for (const t of pending) {
    const planned = await plan(client, t, account, byRef.get(t.external_ref), now);
    if ('wait' in planned) continue;
    const unallocated: Record<string, unknown>[] = [];
    let given = 0;
    if ('failed' in planned) {
      unallocated.push({ venueMarket: t.venue_market, amount: String(t.amount), reason: planned.failed });
    } else {
      for (const part of planned) {
        let found: Weight[] = [];
        let basis = '';
        for (const candidate of BASES[t.program] ?? []) {
          found = await weights(client, account, t.program, part, now, candidate);
          basis = candidate;
          if (found.length > 0) break;
        }
        if (found.length === 0) {
          unallocated.push({
            venueMarket: part.venueMarket, amount: part.amount.toString(), from: part.from, to: part.to,
            periodStart: part.periodStart, reason: 'no live strategy of ours quoted or traded it on this account then',
          });
          continue;
        }
        const shares = split(part.amount, found.map(w => w.weight));
        for (const [i, w] of found.entries()) {
          if (shares[i] === 0n) continue;
          given++;
          await client.query(
            `INSERT INTO treasury.transfer_allocation (transfer_id, strategy_id, listing_id, venue_market, amount,
               earned_from, earned_to, period_start, period_end, basis, strategies, inputs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [t.transfer_id, w.strategyId, w.listingId, part.venueMarket, shares[i].toString(), part.from, part.to,
              part.periodStart, part.periodEnd, basis, found.length,
              JSON.stringify({
                marketAmount: part.amount.toString(),
                weights: Object.fromEntries(found.map(x => [x.strategyId, x.weight.toString()])),
              })]);
        }
      }
    }
    const state = unallocated.length === 0 ? 'DONE' : given > 0 ? 'PARTIAL' : 'FAILED';
    await client.query('UPDATE treasury.transfer SET allocation_state = $2, unallocated = $3 WHERE transfer_id = $1',
      [t.transfer_id, state, unallocated.length === 0 ? null : JSON.stringify(unallocated)]);
    settled++;
  }
  return settled;
}
