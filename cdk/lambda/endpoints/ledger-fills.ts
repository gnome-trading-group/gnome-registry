import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectLedgerDatabase, createResponse } from './ledger-common';
import { markPrice, notional, toBigInt } from './ledger-math';
import { listingColumns, pageFilters, pageOrder } from './ledger-page';
import { toMark } from './pnl-state';

// A session's fills, or a strategy's across its sessions, newest first (see ledger-page for filters and paging).
// Each fill carries the listing's mark when it traded and its slippage against it: positive when the fill was better
// than the mark (bought below it, sold above it), in money for the fill's whole quantity.
const SOURCES = ['VENUE', 'RECOVERY', 'RESET', 'ADJUSTMENT', 'GAP'];
// Event times before this are not epoch nanoseconds (rows that never traded carry none).
const MIN_EPOCH_NS = 1_000_000_000_000_000_000n;

export function buildFillsQuery(params: Record<string, string | undefined>): { text: string; values: unknown[] } {
  const page = pageFilters(params, 'f', 'fill_id', 'recorded_at');
  if (params.source) {
    const sources = params.source.split(',');
    if (sources.some(s => !SOURCES.includes(s))) throw new Error(`source must be among ${SOURCES.join(', ')}`);
    page.values.push(sources);
    page.where.push(`f.source = ANY($${page.values.length}::text[])`);
  }
  return {
    text: `
      SELECT f.*, l.exchange_security_symbol AS symbol, l.exchange_id, spec.tick_size, spec.lot_size,
        mk.bid AS mark_bid, mk.ask AS mark_ask, mk.last_trade AS mark_last_trade
      FROM ledger.fill f
      ${listingColumns('f')}
      LEFT JOIN LATERAL (
        SELECT bid, ask, last_trade FROM ledger.mark m
        WHERE m.listing_id = f.listing_id AND f.fill_price IS NOT NULL
          AND m.ts <= CASE WHEN f.event_time_ns >= ${MIN_EPOCH_NS}
            THEN to_timestamp(f.event_time_ns::numeric / 1e9) ELSE f.recorded_at END
        ORDER BY m.ts DESC LIMIT 1
      ) mk ON TRUE
      WHERE ${page.where.join(' AND ')}
      ${pageOrder('f.fill_id', page)}`,
    values: page.values,
  };
}

export function withSlippage<T extends Record<string, unknown>>(row: T) {
  const mark = markPrice(toMark({ bid: row.mark_bid, ask: row.mark_ask, last_trade: row.mark_last_trade }));
  let slippage: string | null = null;
  if (mark !== 0n && row.fill_price !== null && row.fill_qty !== null) {
    const price = toBigInt(row.fill_price);
    const better = row.side === 0 ? mark - price : price - mark;
    slippage = notional(better, toBigInt(row.fill_qty)).toString();
  }
  return { ...row, mark_price: mark === 0n ? null : mark.toString(), slippage };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  let query;
  try {
    query = buildFillsQuery(event.queryStringParameters ?? {});
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const rows = (await client.query(query)).rows
      .map(withSlippage)
      .sort((a, b) => Number(BigInt(b.fill_id) - BigInt(a.fill_id)));
    return createResponse(200, { rows, nextBefore: rows.length > 0 ? rows[rows.length - 1].fill_id : null });
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
