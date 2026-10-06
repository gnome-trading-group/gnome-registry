import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { withTransaction } from './base';
import { connectLedgerDatabase, createResponse, isSessionId, WRITABLE_SESSION_STATUSES } from './ledger-common';

// One running session's ledger events, written in a single transaction. The body is handed to Postgres as jsonb
// so 64-bit prices, quantities and money never pass through JavaScript numbers.
//
// A session may only write while it might still have a running process and holds a lease on every listing it
// writes for. Anything else is FENCED: a session that was stopped (or lost its lease) must not overwrite what its
// successor now owns.

const BATCH_SOURCES = ['VENUE', 'RECOVERY', 'RESET', 'GAP'];

interface Session {
  strategy_id: number;
  mode: string;
  status: string;
}

class FencedError extends Error {}

const LISTINGS_IN_BATCH = `
  SELECT DISTINCT (e->>'listingId')::int AS listing_id
  FROM (
    SELECT jsonb_array_elements(COALESCE($1::jsonb->'fills', '[]')) AS e
    UNION ALL SELECT jsonb_array_elements(COALESCE($1::jsonb->'orderOpens', '[]'))
    UNION ALL SELECT jsonb_array_elements(COALESCE($1::jsonb->'orderAcks', '[]'))
    UNION ALL SELECT jsonb_array_elements(COALESCE($1::jsonb->'orderCloses', '[]'))
    UNION ALL SELECT jsonb_array_elements(COALESCE($1::jsonb->'marks', '[]'))
    UNION ALL SELECT jsonb_array_elements(COALESCE($1::jsonb->'orderRecoveries', '[]'))
  ) events`;

// Fills, then the position each listing's newest inserted fill leaves. A replayed fill inserts nothing and so moves
// nothing; the version guard keeps a late batch from rolling a position back.
const INSERT_FILLS = `
  WITH src AS (
    SELECT * FROM jsonb_to_recordset(COALESCE($1::jsonb->'fills', '[]')) AS f(
      source text, "originSessionId" text, "listingId" int, "clientOidCounter" bigint, "cumQtyAfter" bigint,
      side smallint, "fillQty" bigint, "fillPrice" bigint, fee bigint, "eventTimeNs" bigint,
      "netQuantityAfter" bigint, "totalCostAfter" bigint, "realizedPnlAfter" bigint, "feesAfter" bigint,
      "positionVersion" bigint, reason text)
  ),
  ins AS (
    INSERT INTO ledger.fill (
      source, session_id, origin_session_id, strategy_id, listing_id, mode, client_oid_counter, cum_qty_after,
      side, fill_qty, fill_price, fee, event_time_ns, net_quantity_after, total_cost_after, realized_pnl_after,
      fees_after, position_version, actor, reason)
    SELECT f.source, $2, f."originSessionId", $3, f."listingId", $4, f."clientOidCounter", f."cumQtyAfter",
      f.side, f."fillQty", f."fillPrice", f.fee, f."eventTimeNs", f."netQuantityAfter", f."totalCostAfter",
      f."realizedPnlAfter", f."feesAfter", f."positionVersion", 'session ' || $2, f.reason
    FROM src f
    ON CONFLICT DO NOTHING
    RETURNING *
  ),
  latest AS (
    SELECT DISTINCT ON (listing_id) * FROM ins ORDER BY listing_id, position_version DESC
  )
  INSERT INTO ledger.position (strategy_id, listing_id, mode, net_quantity, total_cost, version, session_id)
  SELECT strategy_id, listing_id, mode, net_quantity_after, total_cost_after, position_version, $2 FROM latest
  ON CONFLICT (strategy_id, listing_id, mode) DO UPDATE SET
    net_quantity = EXCLUDED.net_quantity,
    total_cost = EXCLUDED.total_cost,
    version = EXCLUDED.version,
    session_id = EXCLUDED.session_id,
    updated_at = NOW()
  WHERE ledger.position.version < EXCLUDED.version`;

// Lost events leave a position that can't be trusted until an operator reviews it.
const MARK_GAPS = `
  UPDATE ledger.position SET needs_review = TRUE, updated_at = NOW()
  WHERE strategy_id = $2 AND mode = $3 AND listing_id IN (
    SELECT (e->>'listingId')::int FROM jsonb_array_elements(COALESCE($1::jsonb->'fills', '[]')) e
    WHERE e->>'source' = 'GAP')`;

// A recovery fill belongs to an order an earlier session of this same strategy and mode placed.
const RECOVERY_ORIGINS_VALID = `
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE($1::jsonb->'fills', '[]')) e
    WHERE e->>'source' = 'RECOVERY' AND NOT EXISTS (
      SELECT 1 FROM strategy.session s
      WHERE s.session_id = e->>'originSessionId' AND s.strategy_id = $2 AND s.mode = $3)
  ) AS valid`;

const ORDER_COLUMNS = `"clientOidCounter" bigint, "listingId" int, "exchangeId" int, side smallint, price bigint,
  size bigint, "exchangeOrderId" text, "filledQty" bigint, "eventTimeNs" bigint`;

function eventTime(column: string): string {
  return `CASE WHEN ${column} > 0 THEN to_timestamp(${column}::numeric / 1e9) ELSE NOW() END`;
}

// Opens insert once. Acks and closes create the row if their open hasn't arrived yet, so the order events can land
// in any order across batches. A venue that gives no id (the paper gateway) acks with an empty one, which is stored
// as null: it identifies nothing, and the venue-id index would otherwise treat every such order as the same one.
const INSERT_ORDER_OPENS = `
  INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode, side, price,
    size, opened_at)
  SELECT $2, o."clientOidCounter", $3, o."listingId", o."exchangeId", $4, o.side, o.price, o.size,
    ${eventTime('o."eventTimeNs"')}
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderOpens', '[]')) AS o(${ORDER_COLUMNS})
  ON CONFLICT (session_id, client_oid_counter) DO UPDATE SET
    side = EXCLUDED.side, price = EXCLUDED.price, size = EXCLUDED.size, opened_at = EXCLUDED.opened_at
  WHERE ledger.order.opened_at IS NULL`;

const UPSERT_ORDER_ACKS = `
  INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode,
    exchange_order_id, acked_at)
  SELECT $2, o."clientOidCounter", $3, o."listingId", o."exchangeId", $4, NULLIF(o."exchangeOrderId", ''),
    ${eventTime('o."eventTimeNs"')}
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderAcks', '[]')) AS o(${ORDER_COLUMNS})
  ON CONFLICT (session_id, client_oid_counter) DO UPDATE SET
    exchange_order_id = EXCLUDED.exchange_order_id, acked_at = EXCLUDED.acked_at`;

const UPSERT_ORDER_CLOSES = `
  INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode, status,
    filled_qty, closed_at)
  SELECT $2, o."clientOidCounter", $3, o."listingId", o."exchangeId", $4, 'CLOSED', o."filledQty",
    ${eventTime('o."eventTimeNs"')}
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderCloses', '[]')) AS o(${ORDER_COLUMNS})
  ON CONFLICT (session_id, client_oid_counter) DO UPDATE SET
    status = CASE WHEN ledger.order.status = 'OPEN' THEN 'CLOSED' ELSE ledger.order.status END,
    filled_qty = EXCLUDED.filled_qty, closed_at = EXCLUDED.closed_at`;

// A starting session settles an order an ended session of its strategy left: cancelled on the venue if it was still
// resting, and any fills the ledger missed booked as RECOVERY fills. Only an ended session's orders can be settled,
// so a running session's orders are never touched.
const MARK_ORDERS_RECOVERED = `
  UPDATE ledger.order o SET status = 'RECOVERED', closed_at = COALESCE(o.closed_at, NOW())
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderRecoveries', '[]')) AS r(
    "originSessionId" text, "clientOidCounter" bigint, "listingId" int)
  JOIN strategy.session origin ON origin.session_id = r."originSessionId"
  WHERE o.session_id = r."originSessionId" AND o.client_oid_counter = r."clientOidCounter"
    AND o.listing_id = r."listingId" AND o.strategy_id = $2 AND o.mode = $3
    AND origin.status <> ALL($4::text[])`;

const INSERT_MARKS = `
  INSERT INTO ledger.mark (listing_id, ts, bid, ask, last_trade)
  SELECT m."listingId", to_timestamp(m."tsMs"::numeric / 1e3), m.bid, m.ask, m."lastTrade"
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'marks', '[]')) AS m(
    "listingId" int, "tsMs" bigint, bid bigint, ask bigint, "lastTrade" bigint)
  ON CONFLICT DO NOTHING`;

export async function writeBatch(client: PoolClient, sessionId: string, body: string): Promise<void> {
  const sessionResult = await client.query<Session>(
    'SELECT strategy_id, mode, status FROM strategy.session WHERE session_id = $1 FOR SHARE',
    [sessionId]);
  const session = sessionResult.rows[0];
  if (!session) throw new FencedError(`Unknown session ${sessionId}`);
  if (!WRITABLE_SESSION_STATUSES.includes(session.status)) {
    throw new FencedError(`Session ${sessionId} is ${session.status}`);
  }

  const unleased = await client.query<{ listing_id: number }>(
    `${LISTINGS_IN_BATCH}
     EXCEPT SELECT listing_id FROM strategy.session_listing WHERE session_id = $2 AND active`,
    [body, sessionId]);
  if (unleased.rowCount && unleased.rowCount > 0) {
    throw new FencedError(`Session ${sessionId} holds no lease on listings ${unleased.rows.map(r => r.listing_id).join(', ')}`);
  }

  const recovery = await client.query<{ valid: boolean }>(RECOVERY_ORIGINS_VALID, [body, session.strategy_id, session.mode]);
  if (!recovery.rows[0].valid) {
    throw new Error('A RECOVERY fill names an origin session of another strategy or mode');
  }

  const args = [body, sessionId, session.strategy_id, session.mode];
  await client.query(INSERT_FILLS, args);
  await client.query(MARK_GAPS, [body, session.strategy_id, session.mode]);
  await client.query(INSERT_ORDER_OPENS, args);
  await client.query(UPSERT_ORDER_ACKS, args);
  await client.query(UPSERT_ORDER_CLOSES, args);
  await client.query(MARK_ORDERS_RECOVERED, [body, session.strategy_id, session.mode, WRITABLE_SESSION_STATUSES]);
  await client.query(INSERT_MARKS, [body]);
}

export function validateBatch(body: string): string {
  const parsed = JSON.parse(body);
  if (!isSessionId(parsed?.sessionId)) throw new Error('sessionId must be a session id');
  for (const fill of parsed.fills ?? []) {
    if (!BATCH_SOURCES.includes(fill?.source)) {
      throw new Error(`fill source must be one of ${BATCH_SOURCES.join(', ')}`);
    }
  }
  return parsed.sessionId;
}

export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.httpMethod !== 'POST') return createResponse(400, { message: 'Invalid HTTP method' });
  if (!event.body) return createResponse(400, { message: 'Missing body' });

  let sessionId: string;
  try {
    sessionId = validateBatch(event.body);
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }

  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    await withTransaction(client, (c) => writeBatch(c, sessionId, event.body as string));
    return createResponse(200, { ok: true });
  } catch (error) {
    if (error instanceof FencedError) {
      return createResponse(409, { fenced: true, message: error.message });
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('Ledger batch error:', message);
    return createResponse(500, { message });
  } finally {
    client.release();
  }
};
