import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectLedgerDatabase, createResponse, parseMode, WRITABLE_SESSION_STATUSES } from './ledger-common';

// Orders on some listings, for a starting session to recognise what was left resting on the venue: whose each order
// is, whether that session might still be running, and how much of it the ledger has seen filled, at what cost and
// for what fees, so whatever more the venue reports can be booked as the difference.
export function buildOrdersQuery(params: Record<string, string | undefined>): { text: string; values: unknown[] } {
  const mode = parseMode(params.mode);
  if (!mode) throw new Error('mode is required');
  const ids = (params.listingIds ?? '').split(',').filter(Boolean).map(Number);
  if (ids.length === 0 || ids.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new Error('listingIds must be a comma-separated list of positive integers');
  }
  const status = params.status ?? 'OPEN';
  if (status !== 'OPEN' && status !== 'ANY') throw new Error('status must be OPEN or ANY');
  const values: unknown[] = [mode, ids, WRITABLE_SESSION_STATUSES];
  return {
    text: `
      SELECT o.*, s.status AS session_status, s.session_seq, (s.status = ANY($3::text[])) AS session_active,
        COALESCE(f.filled_qty, 0) AS ledger_filled_qty,
        COALESCE(f.filled_notional, 0) AS ledger_filled_notional,
        COALESCE(f.fees, 0) AS ledger_fees
      FROM ledger.order o
      JOIN strategy.session s ON s.session_id = o.session_id
      LEFT JOIN LATERAL (
        SELECT MAX(fill.cum_qty_after) AS filled_qty,
          SUM(TRUNC(fill.fill_qty::numeric * fill.fill_price / 1000000))::bigint AS filled_notional,
          SUM(fill.fee)::bigint AS fees
        FROM ledger.fill fill
        WHERE fill.client_oid_counter = o.client_oid_counter
          AND ((fill.source = 'VENUE' AND fill.session_id = o.session_id)
            OR (fill.source = 'RECOVERY' AND fill.origin_session_id = o.session_id))
      ) f ON TRUE
      WHERE o.mode = $1 AND o.listing_id = ANY($2::int[])${status === 'OPEN' ? ` AND o.status = 'OPEN'` : ''}
      ORDER BY o.session_id, o.client_oid_counter`,
    values,
  };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  let query;
  try {
    query = buildOrdersQuery(event.queryStringParameters ?? {});
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    return createResponse(200, (await client.query(query)).rows);
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
