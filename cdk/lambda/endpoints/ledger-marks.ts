import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, parsePositiveInt } from './ledger-common';
import { markPrice } from './ledger-math';
import { pickResolution } from './pnl-math';
import { toMark } from './pnl-state';

// A listing's price history for a chart: the last top of book and trade in each resolution step (as in the PnL
// series), opening with the one in force when the window starts. mark is derived as the OMS derives it (the mid,
// else the last trade); 0 means unknown.
//   ?listingId=  required; optional start, end (ISO) and resolution (ms)

class BadRequest extends Error {}

function parseTime(value: string | undefined, name: string): Date | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new BadRequest(`${name} must be an ISO time`);
  return time;
}

export async function marks(client: PoolClient, params: Record<string, string | undefined>, now: Date) {
  const listingId = parsePositiveInt(params.listingId);
  if (listingId === undefined || Number.isNaN(listingId)) throw new BadRequest('listingId is required');
  const requested = parsePositiveInt(params.resolution);
  if (Number.isNaN(requested)) throw new BadRequest('resolution must be a positive number of milliseconds');
  const first = (await client.query('SELECT MIN(ts) AS first FROM ledger.mark WHERE listing_id = $1', [listingId]))
    .rows[0].first as Date | null;
  const from = parseTime(params.start, 'start') ?? first ?? now;
  const end = parseTime(params.end, 'end');
  const to = end && end < now ? end : now;
  const stepMs = pickResolution(Math.max(0, to.getTime() - from.getTime()), requested);
  const rows = (await client.query(`
    (SELECT ts, bid, ask, last_trade FROM ledger.mark WHERE listing_id = $1 AND ts <= $2 ORDER BY ts DESC LIMIT 1)
    UNION ALL
    (SELECT DISTINCT ON (date_bin($4::interval, ts, 'epoch'::timestamptz)) ts, bid, ask, last_trade
     FROM ledger.mark WHERE listing_id = $1 AND ts > $2 AND ts <= $3
     ORDER BY date_bin($4::interval, ts, 'epoch'::timestamptz), ts DESC)`,
  [listingId, from, to, `${stepMs} milliseconds`])).rows;
  const result = { resolutionMs: stepMs, t: [] as number[], bid: [] as string[], ask: [] as string[],
    lastTrade: [] as string[], mark: [] as string[] };
  for (const r of rows) {
    // The mark in force at the window's start is drawn from the start.
    result.t.push(Math.max(from.getTime(), r.ts.getTime()));
    result.bid.push(String(r.bid));
    result.ask.push(String(r.ask));
    result.lastTrade.push(String(r.last_trade));
    result.mark.push(markPrice(toMark(r)).toString());
  }
  return result;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    return createResponse(200, await marks(client, event.queryStringParameters ?? {}, new Date()));
  } catch (error) {
    if (error instanceof BadRequest) return createResponse(400, { message: error.message });
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
