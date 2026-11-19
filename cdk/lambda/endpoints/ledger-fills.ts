import { APIGatewayProxyEvent } from 'aws-lambda';
import { connectLedgerDatabase, createResponse, isSessionId } from './ledger-common';
import { markPrice, notional, pricedMark, toBigInt } from './ledger-math';
import { listingColumns, pageFilters, pageOrder, roleFilter } from './ledger-page';
import { toMark } from './pnl-state';

// A session's fills, or a strategy's across its sessions, newest first (see ledger-page for filters and paging); or
// one order's fills (?orderSessionId=&clientOidCounter=), oldest first, including those a later session recovered
// from the venue for it. Each fill carries the listing's mark when it traded and its slippage against it: positive
// when the fill was better than the mark (bought below it, sold above it), in money for the fill's whole quantity,
// and what its order was for (order_role and order_episode_id; null for fills of no order). ?role=
// keeps the fills of orders sent for those purposes. ?sessionId=&episodeId= gives one episode's fills, oldest first.
const SOURCES = ['VENUE', 'RECOVERY', 'RESET', 'ADJUSTMENT', 'MANUAL', 'SETTLEMENT', 'GAP'];
// Event times before this are not epoch nanoseconds (rows that never traded carry none).
const MIN_EPOCH_NS = 1_000_000_000_000_000_000n;

const ORDER_FILLS_LIMIT = 1000;

function fillTime(alias: string): string {
  return `CASE WHEN ${alias}.event_time_ns >= ${MIN_EPOCH_NS}
    THEN to_timestamp(${alias}.event_time_ns::numeric / 1e9) ELSE ${alias}.recorded_at END`;
}

// A fill's order is in the session that sent it: the fill's own for a venue fill, its origin for a recovered one.
// Looked up per fill by its key: joined, the planner hashes every order in the ledger to filter a page of fills.
const orderOfFill = (session: string) => `LEFT JOIN LATERAL (
    SELECT o.role, o.episode_id, o.client_oid_counter FROM ledger.order o
    WHERE o.session_id = ${session} AND o.client_oid_counter = f.client_oid_counter
  ) ord ON TRUE`;
const ORDER_OF_FILL = orderOfFill(`CASE f.source WHEN 'VENUE' THEN f.session_id WHEN 'RECOVERY' THEN f.origin_session_id END`);

const selectFills = (orderJoin: string) => `
  SELECT f.*, l.exchange_security_symbol AS symbol, l.exchange_id, spec.price_bands, spec.lot_size,
    mk.bid AS mark_bid, mk.ask AS mark_ask, mk.last_trade AS mark_last_trade,
    ord.role AS order_role, ord.episode_id AS order_episode_id
  FROM ledger.fill f
  ${listingColumns('f')}
  ${orderJoin}
  LEFT JOIN LATERAL (
    SELECT bid, ask, last_trade FROM ledger.mark m
    WHERE m.listing_id = f.listing_id AND f.fill_price IS NOT NULL AND ${pricedMark('m')}
      AND m.ts <= ${fillTime('f')}
    ORDER BY m.ts DESC LIMIT 1
  ) mk ON TRUE`;

function orderFilter(params: Record<string, string | undefined>): { where: string; values: unknown[] } | null {
  if (!params.orderSessionId) return null;
  if (!isSessionId(params.orderSessionId)) throw new Error('orderSessionId must be a session id');
  if (!params.clientOidCounter || !/^\d+$/.test(params.clientOidCounter)) {
    throw new Error('clientOidCounter is required with orderSessionId');
  }
  return {
    where: `f.client_oid_counter = $2 AND ((f.source = 'VENUE' AND f.session_id = $1)
      OR (f.source = 'RECOVERY' AND f.origin_session_id = $1))`,
    values: [params.orderSessionId, params.clientOidCounter],
  };
}

// An episode is the strategy's id for a quote fill and the hedges it set off: the counter of the quote order whose
// fill opened it, carried on each hedge. The other quote fills that land while it is open (the other side's bid
// filling before the pull reaches the venue) were placed before it existed, so they carry nothing; each belongs to
// the episode of the first hedge sent after it, since the strategy hedges whatever gap it holds with the episode
// that is open. The opening order's own fills are taken by id rather than by time: fill times are the venue's clock
// and order times the OMS's, so a fill hedged within the clocks' skew could look newer than its hedge.
// Every fill here is of an order the session sent, so orders are found by their key rather than through the fill's
// source. The session's hedges are read once, not once per quote fill.
function episodeQuery(params: Record<string, string | undefined>): { text: string; values: unknown[] } | null {
  if (params.episodeId === undefined) return null;
  if (!params.sessionId || !isSessionId(params.sessionId)) throw new Error('episodeId needs a sessionId');
  if (!/^[1-9]\d*$/.test(params.episodeId)) throw new Error('episodeId must be a positive integer');
  return {
    text: `
      WITH hedges AS MATERIALIZED (
        SELECT episode_id, opened_at FROM ledger.order WHERE session_id = $1 AND role = 'HEDGE'
      )
      ${selectFills(orderOfFill('$1'))}
      WHERE ((f.source = 'VENUE' AND f.session_id = $1) OR (f.source = 'RECOVERY' AND f.origin_session_id = $1))
        AND ((ord.role = 'HEDGE' AND ord.episode_id = $2)
          OR (ord.role = 'QUOTE' AND (ord.client_oid_counter = $2 OR (
            ${fillTime('f')} <= (SELECT max(h.opened_at) FROM hedges h WHERE h.episode_id = $2)
            AND (SELECT h.episode_id FROM hedges h WHERE h.opened_at >= ${fillTime('f')}
              ORDER BY h.opened_at LIMIT 1) = $2))))
      ORDER BY f.fill_id LIMIT ${ORDER_FILLS_LIMIT}`,
    values: [params.sessionId, params.episodeId],
  };
}

export function buildFillsQuery(params: Record<string, string | undefined>): { text: string; values: unknown[] } {
  const episode = episodeQuery(params);
  if (episode) return episode;
  const order = orderFilter(params);
  if (order) {
    return {
      text: `${selectFills(ORDER_OF_FILL)} WHERE ${order.where} ORDER BY f.fill_id LIMIT ${ORDER_FILLS_LIMIT}`,
      values: order.values,
    };
  }
  const page = pageFilters(params, 'f', 'fill_id', 'recorded_at');
  if (params.source) {
    const sources = params.source.split(',');
    if (sources.some(s => !SOURCES.includes(s))) throw new Error(`source must be among ${SOURCES.join(', ')}`);
    page.values.push(sources);
    page.where.push(`f.source = ANY($${page.values.length}::text[])`);
  }
  roleFilter(params, page, 'ord.role');
  return {
    text: `${selectFills(ORDER_OF_FILL)} WHERE ${page.where.join(' AND ')} ${pageOrder('f.fill_id', page)}`,
    values: page.values,
  };
}

export function withSlippage<T extends Record<string, unknown>>(row: T) {
  const mark = markPrice(toMark({ bid: row.mark_bid, ask: row.mark_ask, last_trade: row.mark_last_trade }));
  let slippage: string | null = null;
  // A settlement trades at the market's result, not against its book, so it has no slippage.
  if (mark !== null && row.fill_price !== null && row.fill_qty !== null && row.source !== 'SETTLEMENT') {
    const price = toBigInt(row.fill_price);
    const better = row.side === 0 ? mark - price : price - mark;
    slippage = notional(better, toBigInt(row.fill_qty)).toString();
  }
  return { ...row, mark_price: mark?.toString() ?? null, slippage };
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
    const params = event.queryStringParameters ?? {};
    const oldestFirst = !!params.orderSessionId || params.episodeId !== undefined;
    const rows = (await client.query(query)).rows
      .map(withSlippage)
      .sort((a, b) => Number(oldestFirst ? BigInt(a.fill_id) - BigInt(b.fill_id) : BigInt(b.fill_id) - BigInt(a.fill_id)));
    return createResponse(200, { rows, nextBefore: rows.length > 0 ? rows[rows.length - 1].fill_id : null });
  } catch (error) {
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
