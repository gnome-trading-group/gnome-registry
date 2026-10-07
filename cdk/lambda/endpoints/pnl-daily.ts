import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, parseMode, parsePositiveInt } from './ledger-common';
import { BadRequest, parseTimeZone } from './pnl-summary';
import { walkLifetime } from './pnl-walk';

// PnL per day in the viewer's time zone: the change in lifetime PnL from one local midnight to the next (today's up
// to now). Taken from the same walk as the charts, so the days always add up to the chart's change.
//   ?strategyId=&mode=&tz=&days=   one strategy; or ?mode=&tz=&days= for every strategy in the mode, with each
//                                  strategy's own days as well when &byStrategy=true

const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;
// Local midnights fall on quarter hours in every zone, so marks binned this finely are read up to each midnight.
const MARK_STEP_MS = 15 * 60_000;

export async function daily(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
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
  const requested = parsePositiveInt(params.days);
  if (Number.isNaN(requested)) throw new BadRequest('days must be a positive integer');
  const days = Math.min(requested ?? DEFAULT_DAYS, MAX_DAYS);

  // Stepping in local time keeps each day a calendar day across daylight-saving changes.
  const starts = (await client.query(`
    SELECT to_char(d, 'YYYY-MM-DD') AS date, d AT TIME ZONE $2 AS start
    FROM generate_series(
      date_trunc('day', $1::timestamptz AT TIME ZONE $2) - ($3::int - 1) * interval '1 day',
      date_trunc('day', $1::timestamptz AT TIME ZONE $2),
      interval '1 day') d
    ORDER BY d`, [now, timeZone, days])).rows as { date: string; start: Date }[];
  const times = [...starts.map(s => s.start.getTime()), now.getTime()];
  const walk = await walkLifetime(client, {
    mode, strategyId: strategyId ?? null, fromMs: times[0], toMs: now.getTime(), markStepMs: MARK_STEP_MS, times,
    sessionEvents: false,
  });
  const changes = (totals: bigint[]) => starts.map((s, i) => ({
    date: s.date,
    start: s.start.toISOString(),
    pnl: (totals[i + 1] - totals[i]).toString(),
  }));
  type Days = ReturnType<typeof changes>;
  const result: { timeZone: string; days: Days; strategies?: { strategyId: number; days: Days }[] } =
    { timeZone, days: changes(walk.total) };
  if (strategyId === undefined && params.byStrategy === 'true') {
    const strategyIds = [...new Set(walk.keys.map(k => k.strategyId))];
    result.strategies = strategyIds.map(id => ({
      strategyId: id,
      days: changes(walk.t.map((_, p) => walk.keys.reduce((sum, key, k) => (key.strategyId === id ? sum + walk.keyTotal[k][p] : sum), 0n))),
    }));
  }
  return result;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    return createResponse(200, await daily(client, event.queryStringParameters ?? {}, new Date()));
  } catch (error) {
    if (error instanceof BadRequest) return createResponse(400, { message: error.message });
    console.error('PnL daily error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
