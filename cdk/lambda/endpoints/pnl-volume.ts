import { PoolClient } from 'pg';
import { SIZE_SCALE, toBigInt } from './ledger-math';

// Trading volume: the money that changed hands in a venue's fills (quantity x price, which adds up across venues where
// contract counts don't), split by whether the fill rested (maker) or crossed (taker), with the fills and fees.
// Settlements, resets, corrections and hand-booked trades move positions but aren't trading, so they don't count. A
// fill a venue reported without its liquidity is in the total but in neither side.

export const TRADED_SOURCES = ['VENUE', 'RECOVERY'];

export interface Volume {
  notional: bigint;
  maker: bigint;
  taker: bigint;
  fills: number;
  fees: bigint;
}

export interface TradeFill {
  source: string;
  fill_qty: string | null;
  fill_price: string | null;
  fee: string | null;
  liquidity: string | null;
}

// Sums quantity x price unscaled and scales once, so a total is the same however its fills were grouped.
export interface Accumulator {
  notional: bigint;
  maker: bigint;
  taker: bigint;
  fills: number;
  fees: bigint;
}

export const emptyAccumulator = (): Accumulator => ({ notional: 0n, maker: 0n, taker: 0n, fills: 0, fees: 0n });

export function addFill(acc: Accumulator, fill: TradeFill): void {
  if (!TRADED_SOURCES.includes(fill.source)) return;
  const gross = toBigInt(fill.fill_qty) * toBigInt(fill.fill_price);
  acc.notional += gross;
  if (fill.liquidity === 'MAKER') acc.maker += gross;
  if (fill.liquidity === 'TAKER') acc.taker += gross;
  acc.fills += 1;
  acc.fees += toBigInt(fill.fee);
}

export function mergeInto(acc: Accumulator, other: Accumulator): void {
  acc.notional += other.notional;
  acc.maker += other.maker;
  acc.taker += other.taker;
  acc.fills += other.fills;
  acc.fees += other.fees;
}

export function finish(acc: Accumulator): Volume {
  return {
    notional: acc.notional / SIZE_SCALE, maker: acc.maker / SIZE_SCALE, taker: acc.taker / SIZE_SCALE,
    fills: acc.fills, fees: acc.fees,
  };
}

export const NO_VOLUME: Volume = finish(emptyAccumulator());

export function volumeFields(v: Volume) {
  return {
    notional: v.notional.toString(), maker: v.maker.toString(), taker: v.taker.toString(), fills: v.fills,
    fees: v.fees.toString(),
  };
}

// Volume between consecutive moments: entry i holds the fills recorded after times[i - 1] up to times[i], and entry 0
// holds none, matching a walk's points, each of which is the state at its moment. Times must be ascending.
export function volumeBetween<T extends TradeFill & { recorded_at: Date }>(fills: T[], times: number[]): Volume[] {
  const buckets = times.map(() => emptyAccumulator());
  for (const fill of fills) {
    const at = fill.recorded_at.getTime();
    if (times.length === 0 || at <= times[0] || at > times[times.length - 1]) continue;
    let lo = 1;
    let hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < at) lo = mid + 1;
      else hi = mid;
    }
    addFill(buckets[lo], fill);
  }
  return buckets.map(finish);
}

export const AGGREGATE = `
  count(*) AS fills,
  COALESCE(sum(fill_qty::numeric * fill_price), 0) AS notional,
  COALESCE(sum(fill_qty::numeric * fill_price) FILTER (WHERE liquidity = 'MAKER'), 0) AS maker,
  COALESCE(sum(fill_qty::numeric * fill_price) FILTER (WHERE liquidity = 'TAKER'), 0) AS taker,
  COALESCE(sum(fee), 0) AS fees`;

export interface AggregateRow {
  fills: string;
  notional: string;
  maker: string;
  taker: string;
  fees: string;
}

// A row's sums, still unscaled, for adding to others before scaling.
export function accumulated(row: AggregateRow): Accumulator {
  return {
    notional: BigInt(row.notional), maker: BigInt(row.maker), taker: BigInt(row.taker), fills: Number(row.fills),
    fees: BigInt(row.fees),
  };
}

function fromAggregate(row: AggregateRow): Volume {
  return finish(accumulated(row));
}

// Each strategy's volume since a moment, in one strategy or every one in the mode.
export async function strategyVolumeSince(
  client: PoolClient, mode: string, strategyId: number | null, since: Date,
): Promise<Map<number, Volume>> {
  const rows = (await client.query(`
    SELECT strategy_id, ${AGGREGATE} FROM ledger.fill
    WHERE mode = $1 AND ($2::int IS NULL OR strategy_id = $2) AND recorded_at > $3 AND source = ANY($4::text[])
    GROUP BY strategy_id`, [mode, strategyId, since, TRADED_SOURCES])).rows;
  return new Map(rows.map(r => [r.strategy_id as number, fromAggregate(r)]));
}

// Each session's whole volume. A fill a later session recovered counts in the session that booked it.
export async function sessionVolumes(client: PoolClient, sessionIds: string[]): Promise<Map<string, Volume>> {
  const rows = (await client.query(`
    SELECT session_id, ${AGGREGATE} FROM ledger.fill
    WHERE session_id = ANY($1::text[]) AND source = ANY($2::text[])
    GROUP BY session_id`, [sessionIds, TRADED_SOURCES])).rows;
  return new Map(rows.map(r => [r.session_id as string, fromAggregate(r)]));
}

export function sumVolumes(volumes: Iterable<Volume>): Volume {
  const total = { ...NO_VOLUME };
  for (const v of volumes) {
    total.notional += v.notional;
    total.maker += v.maker;
    total.taker += v.taker;
    total.fills += v.fills;
    total.fees += v.fees;
  }
  return total;
}
