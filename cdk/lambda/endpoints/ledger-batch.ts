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
//
// Positions are held per venue account. The OMS doesn't know accounts: each row takes the account the session was
// bound to on the listing's exchange when it was created (none in paper mode).

const BATCH_SOURCES = ['VENUE', 'RECOVERY', 'RESET', 'GAP'];
const LIQUIDITIES = ['MAKER', 'TAKER'];
const CLOSE_STATES = ['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'];

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
    UNION ALL SELECT jsonb_array_elements(COALESCE($1::jsonb->'orderModifies', '[]'))
  ) events`;

// The account session $2 trades each listing's exchange with.
const SESSION_ACCOUNTS = `
  SELECT l.listing_id, sva.account_id FROM sm.listing l
  JOIN account_master.session_venue_account sva ON sva.exchange_id = l.exchange_id AND sva.session_id = $2`;

// Fills, then the position each listing's newest inserted fill leaves. A replayed fill inserts nothing and so moves
// nothing; the version guard keeps a late batch from rolling a position back.
const INSERT_FILLS = `
  WITH src AS (
    SELECT * FROM jsonb_to_recordset(COALESCE($1::jsonb->'fills', '[]')) AS f(
      source text, "originSessionId" text, "listingId" int, "clientOidCounter" bigint, "cumQtyAfter" bigint,
      side smallint, "fillQty" bigint, "fillPrice" bigint, fee bigint, "eventTimeNs" bigint,
      "netQuantityAfter" bigint, "totalCostAfter" bigint, "realizedPnlAfter" bigint, "feesAfter" bigint,
      "positionVersion" bigint, reason text, liquidity text)
  ),
  accounts AS (${SESSION_ACCOUNTS}),
  ins AS (
    INSERT INTO ledger.fill (
      source, session_id, origin_session_id, strategy_id, listing_id, mode, client_oid_counter, cum_qty_after,
      side, fill_qty, fill_price, fee, event_time_ns, net_quantity_after, total_cost_after, realized_pnl_after,
      fees_after, position_version, actor, reason, liquidity, account_id)
    SELECT f.source, $2, f."originSessionId", $3, f."listingId", $4, f."clientOidCounter", f."cumQtyAfter",
      f.side, f."fillQty", f."fillPrice", f.fee, f."eventTimeNs", f."netQuantityAfter", f."totalCostAfter",
      f."realizedPnlAfter", f."feesAfter", f."positionVersion", 'session ' || $2, f.reason, f.liquidity,
      a.account_id
    FROM src f LEFT JOIN accounts a ON a.listing_id = f."listingId"
    ON CONFLICT DO NOTHING
    RETURNING *
  ),
  latest AS (
    SELECT DISTINCT ON (listing_id) * FROM ins ORDER BY listing_id, position_version DESC
  )
  INSERT INTO ledger.position (strategy_id, listing_id, mode, account_id, net_quantity, total_cost, version,
    session_id)
  SELECT strategy_id, listing_id, mode, account_id, net_quantity_after, total_cost_after, position_version, $2
  FROM latest
  ON CONFLICT (strategy_id, listing_id, mode, account_id) DO UPDATE SET
    net_quantity = EXCLUDED.net_quantity,
    total_cost = EXCLUDED.total_cost,
    version = EXCLUDED.version,
    session_id = EXCLUDED.session_id,
    updated_at = NOW()
  WHERE ledger.position.version < EXCLUDED.version`;

// Lost events leave a position that can't be trusted until an operator reviews it: the one on the session's own
// account, not the strategy's holdings on other accounts.
const MARK_GAPS = `
  WITH accounts AS (${SESSION_ACCOUNTS.replace('$2', '$4')})
  UPDATE ledger.position p SET needs_review = TRUE, updated_at = NOW()
  FROM jsonb_array_elements(COALESCE($1::jsonb->'fills', '[]')) e
  LEFT JOIN accounts a ON a.listing_id = (e->>'listingId')::int
  WHERE e->>'source' = 'GAP' AND p.strategy_id = $2 AND p.mode = $3
    AND p.listing_id = (e->>'listingId')::int AND p.account_id IS NOT DISTINCT FROM a.account_id`;

// A live session trades every listing through a bound account; writing without one would book a position no
// account holds.
const UNBOUND_LIVE_LISTINGS = `
  ${LISTINGS_IN_BATCH}
  EXCEPT SELECT listing_id FROM (${SESSION_ACCOUNTS}) bound`;

// A recovery fill belongs to an order an earlier session of this same strategy and mode placed, on the account
// this session trades with: a fill on another account's order belongs to that account's position.
const RECOVERY_ORIGINS_VALID = `
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE($1::jsonb->'fills', '[]')) e
    JOIN sm.listing l ON l.listing_id = (e->>'listingId')::int
    WHERE e->>'source' = 'RECOVERY' AND NOT EXISTS (
      SELECT 1 FROM strategy.session s
      LEFT JOIN account_master.session_venue_account origin
        ON origin.session_id = s.session_id AND origin.exchange_id = l.exchange_id
      LEFT JOIN account_master.session_venue_account own
        ON own.session_id = $4 AND own.exchange_id = l.exchange_id
      WHERE s.session_id = e->>'originSessionId' AND s.strategy_id = $2 AND s.mode = $3
        AND origin.account_id IS NOT DISTINCT FROM own.account_id)
  ) AS valid`;

const ORDER_COLUMNS = `"clientOidCounter" bigint, "listingId" int, "exchangeId" int, side smallint, price bigint,
  size bigint, "exchangeOrderId" text, "filledQty" bigint, "eventTimeNs" bigint, state text, "rejectReason" text`;

function eventTime(column: string): string {
  return `CASE WHEN ${column} > 0 THEN to_timestamp(${column}::numeric / 1e9) ELSE NOW() END`;
}

// Opens insert once. Acks and closes create the row if their open hasn't arrived yet, so the order events can land
// in any order across batches. A venue that gives no id (the paper gateway) acks with an empty one, which is stored
// as null: it identifies nothing, and the venue-id index would otherwise treat every such order as the same one.
const ORDER_ACCOUNT = `LEFT JOIN account_master.session_venue_account sva
    ON sva.session_id = $2 AND sva.exchange_id = o."exchangeId"`;

const INSERT_ORDER_OPENS = `
  INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode, side, price,
    size, opened_at, account_id)
  SELECT $2, o."clientOidCounter", $3, o."listingId", o."exchangeId", $4, o.side, o.price, o.size,
    ${eventTime('o."eventTimeNs"')}, sva.account_id
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderOpens', '[]')) AS o(${ORDER_COLUMNS}) ${ORDER_ACCOUNT}
  ON CONFLICT (session_id, client_oid_counter) DO UPDATE SET
    side = EXCLUDED.side, price = EXCLUDED.price, size = EXCLUDED.size, opened_at = EXCLUDED.opened_at
  WHERE ledger.order.opened_at IS NULL`;

const UPSERT_ORDER_ACKS = `
  INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode,
    exchange_order_id, acked_at, account_id)
  SELECT $2, o."clientOidCounter", $3, o."listingId", o."exchangeId", $4, NULLIF(o."exchangeOrderId", ''),
    ${eventTime('o."eventTimeNs"')}, sva.account_id
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderAcks', '[]')) AS o(${ORDER_COLUMNS}) ${ORDER_ACCOUNT}
  ON CONFLICT (session_id, client_oid_counter) DO UPDATE SET
    exchange_order_id = EXCLUDED.exchange_order_id, acked_at = EXCLUDED.acked_at`;

const UPSERT_ORDER_CLOSES = `
  INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode, status,
    filled_qty, closed_at, close_state, reject_reason, account_id)
  SELECT $2, o."clientOidCounter", $3, o."listingId", o."exchangeId", $4, 'CLOSED', o."filledQty",
    ${eventTime('o."eventTimeNs"')}, o.state, o."rejectReason", sva.account_id
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderCloses', '[]')) AS o(${ORDER_COLUMNS}) ${ORDER_ACCOUNT}
  ON CONFLICT (session_id, client_oid_counter) DO UPDATE SET
    status = CASE WHEN ledger.order.status = 'OPEN' THEN 'CLOSED' ELSE ledger.order.status END,
    filled_qty = EXCLUDED.filled_qty, closed_at = EXCLUDED.closed_at, close_state = EXCLUDED.close_state,
    reject_reason = EXCLUDED.reject_reason`;

// A modify the venue confirmed: the order now rests at this price and size. An order that has already closed keeps
// what it ended with.
const APPLY_ORDER_MODIFIES = `
  UPDATE ledger.order o SET price = COALESCE(m.price, o.price), size = m.size, modified_at = ${eventTime('m."eventTimeNs"')}
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderModifies', '[]')) AS m(${ORDER_COLUMNS})
  WHERE o.session_id = $2 AND o.client_oid_counter = m."clientOidCounter" AND o.status = 'OPEN'`;

// Running totals from the OMS: a late or retried batch carries a smaller or equal count, so it never lowers one.
// Not lease-checked: an order refused for naming a listing the session doesn't trade is exactly what to count, and
// counts never touch a position.
const UPSERT_REJECT_COUNTS = `
  INSERT INTO ledger.reject_count (session_id, listing_id, reason, count)
  SELECT $2, r."listingId", r.reason, r.count
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'rejectCounts', '[]')) AS r("listingId" int, reason text, count bigint)
  ON CONFLICT (session_id, listing_id, reason) DO UPDATE SET
    count = GREATEST(ledger.reject_count.count, EXCLUDED.count), updated_at = NOW()`;

// A starting session settles an order an ended session of its strategy left: cancelled on the venue if it was still
// resting, and any fills the ledger missed booked as RECOVERY fills. Only an ended session's orders can be settled,
// so a running session's orders are never touched, and only on the account this session trades with, as its
// credentials can't see another account's orders.
const MARK_ORDERS_RECOVERED = `
  UPDATE ledger.order o SET status = 'RECOVERED', closed_at = COALESCE(o.closed_at, NOW())
  FROM jsonb_to_recordset(COALESCE($1::jsonb->'orderRecoveries', '[]')) AS r(
    "originSessionId" text, "clientOidCounter" bigint, "listingId" int)
  JOIN strategy.session origin ON origin.session_id = r."originSessionId"
  WHERE o.session_id = r."originSessionId" AND o.client_oid_counter = r."clientOidCounter"
    AND o.listing_id = r."listingId" AND o.strategy_id = $2 AND o.mode = $3
    AND origin.status <> ALL($4::text[])
    AND o.account_id IS NOT DISTINCT FROM (
      SELECT sva.account_id FROM account_master.session_venue_account sva
      WHERE sva.session_id = $5 AND sva.exchange_id = o.exchange_id)`;

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

  if (session.mode === 'live') {
    const unbound = await client.query<{ listing_id: number }>(UNBOUND_LIVE_LISTINGS, [body, sessionId]);
    if (unbound.rowCount && unbound.rowCount > 0) {
      throw new FencedError(`Session ${sessionId} has no account bound for listings ${unbound.rows.map(r => r.listing_id).join(', ')}`);
    }
  }

  const recovery = await client.query<{ valid: boolean }>(
    RECOVERY_ORIGINS_VALID, [body, session.strategy_id, session.mode, sessionId]);
  if (!recovery.rows[0].valid) {
    throw new Error('A RECOVERY fill names an origin session of another strategy, mode or account');
  }

  const args = [body, sessionId, session.strategy_id, session.mode];
  await client.query(INSERT_FILLS, args);
  await client.query(MARK_GAPS, [body, session.strategy_id, session.mode, sessionId]);
  await client.query(INSERT_ORDER_OPENS, args);
  await client.query(UPSERT_ORDER_ACKS, args);
  await client.query(UPSERT_ORDER_CLOSES, args);
  await client.query(APPLY_ORDER_MODIFIES, [body, sessionId]);
  await client.query(UPSERT_REJECT_COUNTS, [body, sessionId]);
  await client.query(MARK_ORDERS_RECOVERED,
    [body, session.strategy_id, session.mode, WRITABLE_SESSION_STATUSES, sessionId]);
  await client.query(INSERT_MARKS, [body]);
}

export function validateBatch(body: string): string {
  const parsed = JSON.parse(body);
  if (!isSessionId(parsed?.sessionId)) throw new Error('sessionId must be a session id');
  for (const fill of parsed.fills ?? []) {
    if (!BATCH_SOURCES.includes(fill?.source)) {
      throw new Error(`fill source must be one of ${BATCH_SOURCES.join(', ')}`);
    }
    if (fill.liquidity != null && !LIQUIDITIES.includes(fill.liquidity)) {
      throw new Error(`fill liquidity must be one of ${LIQUIDITIES.join(', ')} or null`);
    }
  }
  for (const close of parsed.orderCloses ?? []) {
    if (close?.state != null && !CLOSE_STATES.includes(close.state)) {
      throw new Error(`order close state must be one of ${CLOSE_STATES.join(', ')}`);
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
