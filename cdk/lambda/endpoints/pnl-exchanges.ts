import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { accrualDeltas } from '../rewards/accruals';
import { connectLedgerDatabase, createResponse, parseMode, parsePositiveInt } from './ledger-common';
import { PRICE_SCALE, toBigInt } from './ledger-math';
import { localDays } from './pnl-daily';
import { BadRequest, parseTimeZone } from './pnl-summary';
import {
  Accumulator, accumulated, AGGREGATE, AggregateRow, emptyAccumulator, finish, mergeInto, TRADED_SOURCES, Volume,
  volumeFields,
} from './pnl-volume';

// Trading on each exchange over the last few local days: the volume (pnl-volume), the rewards and rebates the venue paid
// for it, and what trading there cost net of them per $100 traded. Live breaks it down by venue account, the unit a
// venue's fee tiers count; paper has no accounts, and its rewards are its sessions' estimates.
//   ?mode=&tz=&days=      every exchange traded or rewarded in the window (days: 1 is today; default 30, at most 366)
//     &exchangeId=        that exchange alone, active or not, with each local day's volume as well

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

interface ExchangeTotals {
  volume: Accumulator;
  rewards: bigint;
  accounts: Map<number, { volume: Accumulator; rewards: bigint }>;
  strategies: Map<number, Accumulator>;
}

// What trading cost per $100 traded once the venue's rewards are counted against its fees, in price units; none
// without volume. Negative when the rewards paid more than the fees.
export function netCostPer100(volume: Volume, rewards: bigint): bigint | null {
  if (volume.notional === 0n) return null;
  return ((volume.fees - rewards) * 100n * PRICE_SCALE) / volume.notional;
}

function totalsFor(byExchange: Map<number, ExchangeTotals>, exchangeId: number): ExchangeTotals {
  let totals = byExchange.get(exchangeId);
  if (!totals) {
    totals = { volume: emptyAccumulator(), rewards: 0n, accounts: new Map(), strategies: new Map() };
    byExchange.set(exchangeId, totals);
  }
  return totals;
}

function accountFor(totals: ExchangeTotals, accountId: number) {
  let account = totals.accounts.get(accountId);
  if (!account) {
    account = { volume: emptyAccumulator(), rewards: 0n };
    totals.accounts.set(accountId, account);
  }
  return account;
}

async function loadRewardsByExchange(
  client: PoolClient, mode: string, from: Date, to: Date, exchangeId: number | null, byExchange: Map<number, ExchangeTotals>,
) {
  if (mode === 'live') {
    const rows = (await client.query(`
      SELECT a.exchange_id, t.account_id, sum(t.amount) AS amount
      FROM treasury.transfer t JOIN account_master.venue_account a USING (account_id)
      WHERE t.kind = 'REWARD' AND t.occurred_at > $1 AND t.occurred_at <= $2 AND ($3::int IS NULL OR a.exchange_id = $3)
      GROUP BY a.exchange_id, t.account_id`, [from, to, exchangeId])).rows;
    for (const r of rows) {
      const totals = totalsFor(byExchange, r.exchange_id);
      const amount = toBigInt(r.amount);
      totals.rewards += amount;
      accountFor(totals, r.account_id).rewards += amount;
    }
    return;
  }
  const codes = new Map((await client.query('SELECT exchange_id, exchange_code FROM sm.exchange')).rows
    .map(r => [r.exchange_code as string, r.exchange_id as number]));
  for (const r of await accrualDeltas(client, mode, { strategyId: null }, to)) {
    const id = codes.get(r.exchange_code);
    if (id === undefined || r.as_of <= from || (exchangeId !== null && id !== exchangeId)) continue;
    totalsFor(byExchange, id).rewards += toBigInt(r.amount);
  }
}

export async function exchangeVolumes(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
  let mode;
  try {
    mode = parseMode(params.mode);
  } catch (error) {
    throw new BadRequest(error instanceof Error ? error.message : String(error));
  }
  if (!mode) throw new BadRequest('mode is required');
  const timeZone = parseTimeZone(params.tz);
  const requested = parsePositiveInt(params.days);
  if (Number.isNaN(requested)) throw new BadRequest('days must be a positive integer');
  const days = Math.min(requested ?? DEFAULT_DAYS, MAX_DAYS);
  const exchangeId = parsePositiveInt(params.exchangeId);
  if (Number.isNaN(exchangeId)) throw new BadRequest('exchangeId must be a positive integer');

  const dayList = await localDays(client, now, timeZone, days);
  const from = dayList[0].start;
  const byExchange = new Map<number, ExchangeTotals>();
  if (exchangeId !== undefined) totalsFor(byExchange, exchangeId);

  // Summed per listing before the join, so the join looks up each listing once rather than once per fill.
  const fills = (await client.query(`
    WITH per_listing AS (
      SELECT listing_id, account_id, strategy_id, ${AGGREGATE}
      FROM ledger.fill
      WHERE mode = $1 AND recorded_at > $2 AND recorded_at <= $3 AND source = ANY($4::text[])
      GROUP BY listing_id, account_id, strategy_id)
    SELECT l.exchange_id, p.* FROM per_listing p JOIN sm.listing l ON l.listing_id = p.listing_id
    WHERE $5::int IS NULL OR l.exchange_id = $5`,
  [mode, from, now, TRADED_SOURCES, exchangeId ?? null])).rows as (AggregateRow & {
    exchange_id: number; account_id: number | null; strategy_id: number;
  })[];
  for (const r of fills) {
    const totals = totalsFor(byExchange, r.exchange_id);
    const sums = accumulated(r);
    mergeInto(totals.volume, sums);
    if (r.account_id !== null) mergeInto(accountFor(totals, r.account_id).volume, sums);
    const strategy = totals.strategies.get(r.strategy_id) ?? emptyAccumulator();
    mergeInto(strategy, sums);
    totals.strategies.set(r.strategy_id, strategy);
  }
  await loadRewardsByExchange(client, mode, from, now, exchangeId ?? null, byExchange);

  const exchangeIds = [...byExchange.keys()];
  const exchanges = new Map((await client.query(
    'SELECT exchange_id, exchange_code, exchange_name FROM sm.exchange WHERE exchange_id = ANY($1::int[])',
    [exchangeIds])).rows.map(r => [r.exchange_id as number, r]));
  if (exchangeId !== undefined && !exchanges.has(exchangeId)) return null;
  const accountIds = [...byExchange.values()].flatMap(t => [...t.accounts.keys()]);
  const labels = new Map((await client.query(
    'SELECT account_id, label FROM account_master.venue_account WHERE account_id = ANY($1::int[])',
    [accountIds])).rows.map(r => [r.account_id as number, r.label as string]));
  const strategyIds = [...new Set([...byExchange.values()].flatMap(t => [...t.strategies.keys()]))];
  const names = new Map((await client.query(
    'SELECT strategy_id, name FROM strategy.strategy WHERE strategy_id = ANY($1::int[])',
    [strategyIds])).rows.map(r => [r.strategy_id as number, r.name as string]));

  const rows = exchangeIds.map(id => {
    const totals = byExchange.get(id) as ExchangeTotals;
    const volume = finish(totals.volume);
    const cost = netCostPer100(volume, totals.rewards);
    const info = exchanges.get(id);
    return {
      exchangeId: id,
      exchangeCode: info?.exchange_code ?? null,
      exchangeName: info?.exchange_name ?? null,
      volume: volumeFields(volume),
      rewards: totals.rewards.toString(),
      netCostPer100: cost === null ? null : cost.toString(),
      accounts: [...totals.accounts.entries()]
        .map(([accountId, a]) => ({
          accountId, label: labels.get(accountId) ?? null, volume: finish(a.volume), rewards: a.rewards,
        }))
        .sort((a, b) => (a.volume.notional === b.volume.notional ? a.accountId - b.accountId
          : b.volume.notional > a.volume.notional ? 1 : -1))
        .map(a => ({ ...a, volume: volumeFields(a.volume), rewards: a.rewards.toString() })),
      strategies: [...totals.strategies.entries()]
        .map(([strategyId, v]) => ({ strategyId, name: names.get(strategyId) ?? null, volume: finish(v) }))
        .sort((a, b) => (a.volume.notional === b.volume.notional ? a.strategyId - b.strategyId
          : b.volume.notional > a.volume.notional ? 1 : -1))
        .map(s => ({ ...s, volume: volumeFields(s.volume) })),
    };
  }).sort((a, b) => (BigInt(b.volume.notional) > BigInt(a.volume.notional) ? 1
    : BigInt(b.volume.notional) < BigInt(a.volume.notional) ? -1 : a.exchangeId - b.exchangeId));

  const result: {
    scope: { mode: string; timeZone: string; days: number; from: string; to: string };
    exchanges: typeof rows;
    daily?: { date: string; start: string; volume: ReturnType<typeof volumeFields> }[];
  } = { scope: { mode, timeZone, days, from: from.toISOString(), to: now.toISOString() }, exchanges: rows };
  if (exchangeId !== undefined) {
    const perDay = new Map((await client.query(`
      SELECT to_char(f.recorded_at AT TIME ZONE $6, 'YYYY-MM-DD') AS date, ${AGGREGATE}
      FROM ledger.fill f JOIN sm.listing l ON l.listing_id = f.listing_id
      WHERE f.mode = $1 AND f.recorded_at > $2 AND f.recorded_at <= $3 AND f.source = ANY($4::text[])
        AND l.exchange_id = $5
      GROUP BY 1`, [mode, from, now, TRADED_SOURCES, exchangeId, timeZone])).rows
      .map(r => [r.date as string, finish(accumulated(r))]));
    result.daily = dayList.map(d => ({
      date: d.date, start: d.start.toISOString(), volume: volumeFields(perDay.get(d.date) ?? finish(emptyAccumulator())),
    }));
  }
  return result;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const result = await exchangeVolumes(client, event.queryStringParameters ?? {}, new Date());
    if (result === null) return createResponse(404, { message: 'No such exchange' });
    return createResponse(200, result);
  } catch (error) {
    if (error instanceof BadRequest) return createResponse(400, { message: error.message });
    console.error('Exchange volume error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
