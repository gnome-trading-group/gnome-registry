import { PoolClient } from 'pg';
import { FeeCalculator, newOrderFeeState, OrderFeeState } from '../../fees/calculator';
import { entryAt, ITimelineEntry, loadTimelines } from '../../fees/timeline';
import { FEE_LOOKBACK_MS, FEE_TOLERANCE_UNITS } from './thresholds';
import { Finding, finding, money } from './types';

// Venues whose fills carry the fee they charged. Polymarket International reports none per fill, so its fills carry
// our own computation from the same schedules and could only ever agree.
const VENUE_REPORTED = ['KALSHI', 'POLYMARKET_US'];
const BUY = 0;

interface IFillRow {
  session_id: string;
  client_oid_counter: string;
  listing_id: number;
  side: number;
  fill_qty: string;
  fill_price: string;
  fee: string | null;
  liquidity: 'MAKER' | 'TAKER' | null;
  event_time_ns: string;
  account_id: number | null;
  symbol: string;
  exchange_id: number;
  exchange_code: string;
}

interface IOrderCheck {
  sessionId: string;
  clientOid: string;
  reported: bigint;
  low: bigint;
  high: bigint;
}

// One scenario of an order's fees: fills whose liquidity the venue left unknown are all priced as makers in one and
// all as takers in the other, and the venue's total must fall between the two.
class Scenario {
  total = 0n;
  readonly state: OrderFeeState = newOrderFeeState();
}

/**
 * Live orders whose venue-reported fees differ by more than a cent from what the venue's schedule in the registry says
 * they should be: a venue changed its fees without us recording it, or a listing maps to the wrong schedule. Orders
 * with a fill recorded in the last day are checked whole, fill by fill in the order the venue matched them, since
 * Kalshi carries rounding across an order's fills.
 */
export async function fees(client: PoolClient, now: Date): Promise<Finding[]> {
  const fills: IFillRow[] = (await client.query(`
    WITH recent AS (
      SELECT DISTINCT f.session_id, f.client_oid_counter
      FROM ledger.fill f
      JOIN sm.listing l ON l.listing_id = f.listing_id
      JOIN sm.exchange e ON e.exchange_id = l.exchange_id
      WHERE f.mode = 'live' AND f.source = 'VENUE' AND f.recorded_at > $1 AND e.exchange_code = ANY($2)
    )
    SELECT f.session_id, f.client_oid_counter, f.listing_id, f.side, f.fill_qty, f.fill_price, f.fee, f.liquidity,
      f.event_time_ns, f.account_id, l.exchange_security_symbol AS symbol, l.exchange_id, e.exchange_code
    FROM ledger.fill f
    JOIN recent r ON r.session_id = f.session_id AND r.client_oid_counter = f.client_oid_counter
    JOIN sm.listing l ON l.listing_id = f.listing_id
    JOIN sm.exchange e ON e.exchange_id = l.exchange_id
    WHERE f.mode = 'live' AND f.source = 'VENUE'
    ORDER BY f.session_id, f.client_oid_counter, f.event_time_ns, f.fill_id`,
  [new Date(now.getTime() - FEE_LOOKBACK_MS), VENUE_REPORTED])).rows;
  if (fills.length === 0) return [];

  const timelines = await loadTimelines(client, [...new Set(fills.map((f) => f.listing_id))]);
  const calculators = new Map<string, FeeCalculator>();
  const calculatorFor = (entry: ITimelineEntry) => {
    let calculator = calculators.get(entry.feeScheduleId);
    if (!calculator) {
      calculator = new FeeCalculator(entry.definition);
      calculators.set(entry.feeScheduleId, calculator);
    }
    return calculator;
  };

  const byOrder = new Map<string, IFillRow[]>();
  for (const f of fills) {
    const key = `${f.session_id}:${f.client_oid_counter}`;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key)!.push(f);
  }

  const checks = new Map<number, IOrderCheck[]>();
  const unknown = new Map<number, Date>();
  for (const orderFills of byOrder.values()) {
    const listingId = orderFills[0].listing_id;
    const asMakers = new Scenario();
    const asTakers = new Scenario();
    let reported = 0n;
    let covered = true;
    for (const f of orderFills) {
      const at = new Date(Number(BigInt(f.event_time_ns) / 1_000_000n));
      const entry = entryAt(timelines.get(listingId)!, at);
      if (!entry) {
        if (!unknown.has(listingId) || at < unknown.get(listingId)!) unknown.set(listingId, at);
        covered = false;
        break;
      }
      const calculator = calculatorFor(entry);
      const buy = f.side === BUY;
      const price = BigInt(f.fill_price);
      const qty = BigInt(f.fill_qty);
      for (const [scenario, unknownIsMaker] of [[asMakers, true], [asTakers, false]] as [Scenario, boolean][]) {
        const maker = f.liquidity === null ? unknownIsMaker : f.liquidity === 'MAKER';
        scenario.total += calculator.fee(buy, price, qty, maker, scenario.state);
      }
      reported += BigInt(f.fee ?? 0);
    }
    if (!covered) continue;
    const low = asMakers.total < asTakers.total ? asMakers.total : asTakers.total;
    const high = asMakers.total < asTakers.total ? asTakers.total : asMakers.total;
    if (!checks.has(listingId)) checks.set(listingId, []);
    checks.get(listingId)!.push({
      sessionId: orderFills[0].session_id, clientOid: orderFills[0].client_oid_counter, reported, low, high,
    });
  }

  const describe = new Map(fills.map((f) => [f.listing_id, f]));
  const findings: Finding[] = [];
  for (const [listingId, orders] of checks) {
    const off = orders
      .map((o) => ({ ...o, diff: o.reported < o.low ? o.reported - o.low : o.reported > o.high ? o.reported - o.high : 0n }))
      .filter((o) => o.diff < -FEE_TOLERANCE_UNITS || o.diff > FEE_TOLERANCE_UNITS);
    if (off.length === 0) continue;
    const total = off.reduce((sum, o) => sum + o.diff, 0n);
    const worst = off.reduce((a, b) => ((a.diff < 0n ? -a.diff : a.diff) >= (b.diff < 0n ? -b.diff : b.diff) ? a : b));
    const expected = worst.low === worst.high ? money(worst.low) : `${money(worst.low)} to ${money(worst.high)}`;
    const f = describe.get(listingId)!;
    findings.push(finding('live', 'info', 'FEE_MISMATCH', [listingId],
      `${f.exchange_code} charged different fees than its schedule on ${f.symbol}`, {
        listingId, symbol: f.symbol, exchangeId: f.exchange_id, exchangeName: f.exchange_code, accountId: f.account_id,
        detail: `${off.length} of ${orders.length} orders in the last day differ by ${money(total)} in all; order `
          + `${worst.clientOid} of session ${worst.sessionId} was charged ${money(worst.reported)}, expected ${expected}`,
        facts: { orders: orders.length, mismatched: off.length, differenceUnits: Number(total) },
      }));
  }
  for (const [listingId, at] of unknown) {
    const f = describe.get(listingId)!;
    findings.push(finding('live', 'info', 'FEE_SCHEDULE_MISSING', [listingId],
      `No fee schedule for ${f.symbol} on ${f.exchange_code}`, {
        listingId, symbol: f.symbol, exchangeId: f.exchange_id, exchangeName: f.exchange_code, accountId: f.account_id,
        detail: `The registry has no fee schedule in force at ${at.toISOString()}, when it filled`,
        since: at.toISOString(),
      }));
  }
  return findings;
}

interface IScheduleChangeRow {
  exchange_id: number;
  exchange_code: string;
  target: string;
  effective_from: Date;
  recorded_at: Date;
  definition: { components: { taker?: number; maker?: number }[] } | null;
  source_ref: string;
}

const LISTED_CHANGES = 10;
// The classifier dates a fee type it has no rollout date for from the sync that first sees it; a schedule taking
// effect this close to when it was recorded is one of those, not a change the venue announced ahead.
const DATED_ON_SIGHT_MS = 3_600_000;

function describeChange(row: IScheduleChangeRow, now: Date): string {
  const component = row.definition?.components[0];
  const rates = component ? `taker ${component.taker ?? 0}, maker ${component.maker ?? 0}` : 'no fees';
  const onSight = Math.abs(row.effective_from.getTime() - row.recorded_at.getTime()) < DATED_ON_SIGHT_MS;
  const from = row.effective_from.getTime() > now.getTime() ? 'from' : 'since';
  return `${row.target} ${from} ${row.effective_from.toISOString().slice(0, 10)} (${rates})`
    + (onSight ? ', dated from when first seen' : '');
}

/**
 * Fee schedules the venues' own APIs changed, for someone to look over: new or changed fee groups (a Kalshi series, a
 * Polymarket International fee type) recorded in the last day, and Kalshi fee types no schedule expresses, which pay
 * whatever the next scope down charges until someone records the real schedule. Kalshi's event overrides are left
 * out: they come every few days and only move a game's fees within its series' range.
 */
export async function feeScheduleChanges(client: PoolClient, now: Date): Promise<Finding[]> {
  const findings: Finding[] = [];
  const changes: IScheduleChangeRow[] = (await client.query(`
    SELECT e.exchange_id, e.exchange_code, f.fee_group AS target, f.effective_from, f.recorded_at, f.definition,
      f.source_ref
    FROM sm.fee_schedule f JOIN sm.exchange e ON e.exchange_id = f.exchange_id
    WHERE f.source = 'VENUE_API' AND f.fee_group IS NOT NULL AND f.recorded_at > $1
      AND f.source_ref NOT LIKE '%:accumulator' AND f.source_ref NOT LIKE '%:unsupported:%'
    ORDER BY e.exchange_code, f.recorded_at, f.fee_group, f.effective_from`,
  [new Date(now.getTime() - FEE_LOOKBACK_MS)])).rows;
  const byExchange = new Map<string, IScheduleChangeRow[]>();
  for (const row of changes) {
    if (!byExchange.has(row.exchange_code)) byExchange.set(row.exchange_code, []);
    byExchange.get(row.exchange_code)!.push(row);
  }
  for (const [exchangeCode, rows] of byExchange) {
    const groups = new Set(rows.map((r) => r.target));
    const listed = rows.slice(0, LISTED_CHANGES).map((r) => describeChange(r, now));
    const more = rows.length > LISTED_CHANGES ? `; and ${rows.length - LISTED_CHANGES} more` : '';
    findings.push(finding('live', 'info', 'FEE_SCHEDULE_CHANGED', [exchangeCode],
      `${exchangeCode} changed the fees of ${groups.size} fee group${groups.size === 1 ? '' : 's'}`, {
        visibleIn: ['live', 'paper'], exchangeId: rows[0].exchange_id, exchangeName: exchangeCode,
        since: rows[0].recorded_at.toISOString(),
        detail: `New schedules in the last day: ${listed.join('; ')}${more}`,
        facts: { groups: groups.size, schedules: rows.length },
      }));
  }

  // The latest schedule of each target, unsupported or not, so recording the real schedule clears the finding.
  const unsupported: (IScheduleChangeRow & { fee_type: string })[] = (await client.query(`
    SELECT * FROM (
      SELECT DISTINCT ON (f.exchange_id, f.fee_group, f.fee_event) e.exchange_id, e.exchange_code,
        COALESCE(f.fee_group, f.fee_event) AS target, f.effective_from, f.recorded_at, f.definition, f.source_ref,
        split_part(f.source_ref, ':unsupported:', 2) AS fee_type
      FROM sm.fee_schedule f JOIN sm.exchange e ON e.exchange_id = f.exchange_id
      WHERE f.listing_id IS NULL AND (f.fee_group IS NOT NULL OR f.fee_event IS NOT NULL)
        AND EXISTS (SELECT 1 FROM sm.fee_schedule u
          WHERE u.source_ref LIKE '%:unsupported:%' AND u.exchange_id = f.exchange_id
            AND u.fee_group IS NOT DISTINCT FROM f.fee_group AND u.fee_event IS NOT DISTINCT FROM f.fee_event)
      ORDER BY f.exchange_id, f.fee_group, f.fee_event, f.effective_from DESC, f.recorded_at DESC
    ) latest WHERE source_ref LIKE '%:unsupported:%'`)).rows;
  for (const row of unsupported) {
    findings.push(finding('live', 'info', 'FEE_TYPE_UNSUPPORTED', [row.exchange_code, row.target],
      `${row.exchange_code} charges ${row.target} a fee type no schedule expresses (${row.fee_type})`, {
        visibleIn: ['live', 'paper'], exchangeId: row.exchange_id, exchangeName: row.exchange_code,
        since: row.effective_from.toISOString(),
        detail: `Since ${row.effective_from.toISOString().slice(0, 10)} its fees fall through to the next scope down, `
          + 'which is likely wrong; record its real schedule in Security Master → Fees',
      }));
  }
  return findings;
}
