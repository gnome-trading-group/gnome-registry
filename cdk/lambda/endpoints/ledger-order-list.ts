import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectLedgerDatabase, createResponse } from './ledger-common';
import { listingColumns, pageFilters, pageOrder } from './ledger-page';

// A session's orders, or a strategy's across its sessions, newest first (see ledger-page for filters and paging),
// each with what filled: how many fills, the quantity, the average price and the fees.
const STATUSES = ['OPEN', 'CLOSED', 'ANY'];

export function buildOrderListQuery(params: Record<string, string | undefined>): { text: string; values: unknown[] } {
  const page = pageFilters(params, 'o', 'order_seq', 'opened_at');
  const status = params.status ?? 'ANY';
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  if (status === 'OPEN') page.where.push(`o.status = 'OPEN'`);
  if (status === 'CLOSED') page.where.push(`o.status <> 'OPEN'`);
  return {
    text: `
      SELECT o.*, l.exchange_security_symbol AS symbol, spec.tick_size, spec.lot_size,
        COALESCE(f.fills, 0) AS fills, COALESCE(f.fill_qty, 0) AS fill_qty, f.avg_fill_price,
        COALESCE(f.fees, 0) AS fees
      FROM ledger.order o
      ${listingColumns('o')}
      LEFT JOIN LATERAL (
        SELECT count(*) AS fills, SUM(fill.fill_qty) AS fill_qty, SUM(fill.fee) AS fees,
          TRUNC(SUM(fill.fill_qty::numeric * fill.fill_price) / NULLIF(SUM(fill.fill_qty), 0))::bigint AS avg_fill_price
        FROM ledger.fill fill
        WHERE fill.client_oid_counter = o.client_oid_counter
          AND ((fill.source = 'VENUE' AND fill.session_id = o.session_id)
            OR (fill.source = 'RECOVERY' AND fill.origin_session_id = o.session_id))
      ) f ON TRUE
      WHERE ${page.where.join(' AND ')}
      ${pageOrder('o.order_seq', page)}`,
    values: page.values,
  };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  let query;
  try {
    query = buildOrderListQuery(event.queryStringParameters ?? {});
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const rows = (await client.query(query)).rows
      .sort((a, b) => Number(BigInt(b.order_seq) - BigInt(a.order_seq)));
    return createResponse(200, { rows, nextBefore: rows.length > 0 ? rows[rows.length - 1].order_seq : null });
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
