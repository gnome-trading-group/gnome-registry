import { PoolClient } from 'pg';
import { MarkInputs, PositionState, toBigInt } from './ledger-math';

// Reads the ledger state PnL is derived from: positions from fills (GAP rows carry no position of their own) and
// marks as of a moment. Every lookup is an as-of query on an indexed (key, time) pair.

export interface ListingInfo {
  listingId: number;
  symbol: string | null;
  exchangeId: number | null;
  tickSize: string | null;
  lotSize: string | null;
}

export interface SessionListingState {
  sessionId: string;
  strategyId: number;
  mode: string;
  status: string;
  listingId: number;
  startedAt: Date;
  stoppedAt: Date | null;
  asOf: Date;
  startedFlat: boolean;
  opening: PositionState;
  openingMark: MarkInputs | null;
  current: PositionState;
  mark: MarkInputs | null;
  markTime: Date | null;
  version: string | null;
  lastFillAt: Date | null;
}

// One per venue account the strategy holds the listing on (a single one with no account in paper mode): an account
// moved off while it drains keeps its own position, which is valued and summed separately.
export interface StrategyListingState {
  strategyId: number;
  listingId: number;
  accountId: number | null;
  position: PositionState;
  mark: MarkInputs | null;
  markTime: Date | null;
  version: string;
  lastFillAt: Date;
  // The newest fill row's id: unique per row, so it orders and pages them.
  fillId: string;
}

export interface SessionTotals {
  sessionId: string;
  strategyId: number;
  listingId: number;
  realized: bigint;
  fees: bigint;
}

export interface StrategyState {
  listings: StrategyListingState[];
  // Each session's realized PnL and fees per listing as of the moment, so a series can carry them forward.
  sessions: SessionTotals[];
}

export function toMark(row: { bid?: unknown; ask?: unknown; last_trade?: unknown } | null | undefined): MarkInputs | null {
  if (!row || row.bid === null || row.bid === undefined) return null;
  return { bid: toBigInt(row.bid), ask: toBigInt(row.ask), lastTrade: toBigInt(row.last_trade) };
}

export const FLAT: PositionState = { netQuantity: 0n, totalCost: 0n, realizedPnl: 0n, totalFees: 0n };

function position(net: unknown, cost: unknown, realized?: unknown, fees?: unknown): PositionState {
  return {
    netQuantity: toBigInt(net), totalCost: toBigInt(cost), realizedPnl: toBigInt(realized), totalFees: toBigInt(fees),
  };
}

export async function loadListingInfo(client: PoolClient, listingIds: number[]): Promise<Map<number, ListingInfo>> {
  const info = new Map<number, ListingInfo>();
  if (listingIds.length === 0) return info;
  const rows = (await client.query(`
    SELECT l.listing_id, l.exchange_security_symbol AS symbol, l.exchange_id, spec.tick_size, spec.lot_size
    FROM sm.listing l
    LEFT JOIN LATERAL (
      SELECT tick_size, lot_size FROM sm.listing_spec s WHERE s.listing_id = l.listing_id
      ORDER BY recorded_at DESC LIMIT 1
    ) spec ON TRUE
    WHERE l.listing_id = ANY($1::int[])`, [listingIds])).rows;
  for (const r of rows) {
    info.set(r.listing_id, {
      listingId: r.listing_id,
      symbol: r.symbol,
      exchangeId: r.exchange_id,
      tickSize: r.tick_size === null ? null : String(r.tick_size),
      lotSize: r.lot_size === null ? null : String(r.lot_size),
    });
  }
  return info;
}

// Each session's listings: what it inherited when it started (nothing if it started flat), what it holds now (or
// when it stopped), its own realized PnL and fees, and the marks at both moments.
export async function loadSessionStates(client: PoolClient, sessionIds: string[], now: Date): Promise<SessionListingState[]> {
  if (sessionIds.length === 0) return [];
  const rows = (await client.query(`
    WITH s AS (
      SELECT session_id, strategy_id, mode, status, started_at, stopped_at,
        LEAST(COALESCE(stopped_at, $2::timestamptz), $2::timestamptz) AS as_of
      FROM strategy.session WHERE session_id = ANY($1::text[])
    ),
    l AS (
      SELECT session_id, listing_id FROM strategy.session_listing WHERE session_id = ANY($1::text[])
      UNION SELECT DISTINCT session_id, listing_id FROM ledger.fill WHERE session_id = ANY($1::text[])
    )
    SELECT s.*, l.listing_id,
      EXISTS (SELECT 1 FROM ledger.fill r
              WHERE r.session_id = s.session_id AND r.listing_id = l.listing_id AND r.source = 'RESET') AS started_flat,
      op.net_quantity_after AS open_net, op.total_cost_after AS open_cost, op.position_version AS open_version,
      cur.net_quantity_after AS cur_net, cur.total_cost_after AS cur_cost, cur.realized_pnl_after, cur.fees_after,
      cur.position_version, cur.recorded_at AS last_fill_at,
      m0.bid AS open_bid, m0.ask AS open_ask, m0.last_trade AS open_last,
      m1.bid, m1.ask, m1.last_trade, m1.ts AS mark_time
    FROM s JOIN l USING (session_id)
    -- What the session inherited is the position on the account it trades the listing with.
    LEFT JOIN LATERAL (
      SELECT net_quantity_after, total_cost_after, position_version FROM ledger.fill f
      WHERE f.strategy_id = s.strategy_id AND f.mode = s.mode AND f.listing_id = l.listing_id
        AND f.source <> 'GAP' AND f.recorded_at < s.started_at
        AND f.account_id IS NOT DISTINCT FROM (
          SELECT sva.account_id FROM sm.listing ll
          JOIN account_master.session_venue_account sva
            ON sva.exchange_id = ll.exchange_id AND sva.session_id = s.session_id
          WHERE ll.listing_id = l.listing_id)
      ORDER BY f.fill_id DESC LIMIT 1
    ) op ON TRUE
    LEFT JOIN LATERAL (
      SELECT net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version, recorded_at
      FROM ledger.fill f
      WHERE f.session_id = s.session_id AND f.listing_id = l.listing_id AND f.source <> 'GAP'
        AND f.recorded_at <= s.as_of
      ORDER BY f.fill_id DESC LIMIT 1
    ) cur ON TRUE
    LEFT JOIN LATERAL (
      SELECT bid, ask, last_trade FROM ledger.mark m
      WHERE m.listing_id = l.listing_id AND m.ts <= s.started_at ORDER BY m.ts DESC LIMIT 1
    ) m0 ON TRUE
    LEFT JOIN LATERAL (
      SELECT bid, ask, last_trade, ts FROM ledger.mark m
      WHERE m.listing_id = l.listing_id AND m.ts <= s.as_of ORDER BY m.ts DESC LIMIT 1
    ) m1 ON TRUE
    ORDER BY s.session_id, l.listing_id`, [sessionIds, now])).rows;
  return rows.map(r => {
    const opening = r.started_flat ? FLAT : position(r.open_net, r.open_cost);
    const hasOwnFill = r.cur_net !== null;
    return {
      sessionId: r.session_id,
      strategyId: r.strategy_id,
      mode: r.mode,
      status: r.status,
      listingId: r.listing_id,
      startedAt: r.started_at,
      stoppedAt: r.stopped_at,
      asOf: r.as_of,
      startedFlat: r.started_flat,
      opening,
      openingMark: toMark({ bid: r.open_bid, ask: r.open_ask, last_trade: r.open_last }),
      current: hasOwnFill ? position(r.cur_net, r.cur_cost, r.realized_pnl_after, r.fees_after) : opening,
      mark: toMark(r),
      markTime: r.mark_time,
      version: hasOwnFill ? String(r.position_version) : (r.open_version === null ? null : String(r.open_version)),
      lastFillAt: r.last_fill_at,
    };
  });
}

// A strategy's state (or every strategy's, when strategyId is null) on each listing it has traded in a mode, as of
// a moment: the position its newest fill row left, and each session's realized PnL and fees.
export async function loadStrategyState(
  client: PoolClient, mode: string, strategyId: number | null, at: Date,
): Promise<StrategyState> {
  const filtered = `
    WITH f AS (
      SELECT * FROM ledger.fill
      WHERE mode = $1 AND ($2::int IS NULL OR strategy_id = $2) AND source <> 'GAP' AND recorded_at <= $3
    )`;
  const listings = (await client.query(`${filtered},
    pos AS (
      SELECT DISTINCT ON (strategy_id, listing_id, account_id) strategy_id, listing_id, account_id,
        net_quantity_after, total_cost_after, position_version, recorded_at, fill_id
      FROM f ORDER BY strategy_id, listing_id, account_id, fill_id DESC
    ),
    -- A session trades each listing through one account, so its totals belong to that account's position.
    sess AS (
      SELECT DISTINCT ON (session_id, listing_id) strategy_id, listing_id, account_id, realized_pnl_after, fees_after
      FROM f WHERE session_id IS NOT NULL ORDER BY session_id, listing_id, fill_id DESC
    ),
    -- Each session's running totals end at its last row; a manual trade or a settlement carries only its own amounts.
    tot AS (
      SELECT strategy_id, listing_id, account_id, SUM(realized_pnl_after) AS realized, SUM(fees_after) AS fees
      FROM (SELECT * FROM sess
            UNION ALL
            SELECT strategy_id, listing_id, account_id, realized_pnl_after, fees_after FROM f
            WHERE source IN ('MANUAL', 'SETTLEMENT')) booked
      GROUP BY strategy_id, listing_id, account_id
    )
    SELECT pos.*, COALESCE(tot.realized, 0) AS realized, COALESCE(tot.fees, 0) AS fees,
      mk.bid, mk.ask, mk.last_trade, mk.ts AS mark_time
    FROM pos
    LEFT JOIN tot ON tot.strategy_id = pos.strategy_id AND tot.listing_id = pos.listing_id
      AND tot.account_id IS NOT DISTINCT FROM pos.account_id
    LEFT JOIN LATERAL (
      SELECT bid, ask, last_trade, ts FROM ledger.mark m
      WHERE m.listing_id = pos.listing_id AND m.ts <= $3 ORDER BY m.ts DESC LIMIT 1
    ) mk ON TRUE
    ORDER BY pos.strategy_id, pos.listing_id, pos.account_id`, [mode, strategyId, at])).rows;
  const sessions = (await client.query(`${filtered}
    SELECT DISTINCT ON (session_id, listing_id) session_id, strategy_id, listing_id, realized_pnl_after, fees_after
    FROM f WHERE session_id IS NOT NULL ORDER BY session_id, listing_id, fill_id DESC`,
  [mode, strategyId, at])).rows;
  return {
    listings: listings.map(r => ({
      strategyId: r.strategy_id,
      listingId: r.listing_id,
      accountId: r.account_id,
      position: position(r.net_quantity_after, r.total_cost_after, r.realized, r.fees),
      mark: toMark(r),
      markTime: r.mark_time,
      version: String(r.position_version),
      lastFillAt: r.recorded_at,
      fillId: String(r.fill_id),
    })),
    sessions: sessions.map(r => ({
      sessionId: r.session_id,
      strategyId: r.strategy_id,
      listingId: r.listing_id,
      realized: toBigInt(r.realized_pnl_after),
      fees: toBigInt(r.fees_after),
    })),
  };
}

// Fills that change a strategy's lifetime PnL outside every session's own PnL: a settlement or a manual trade belongs
// to no session, a correction is an operator's, and a reset writes off what its session chose not to inherit.
export const OUT_OF_SESSION_SOURCES = ['SETTLEMENT', 'MANUAL', 'ADJUSTMENT', 'RESET'] as const;
export type OutOfSessionSource = typeof OUT_OF_SESSION_SOURCES[number];

// A fill with the position it found, valued against the newest mark before it, as the PnL chart does (fills before
// marks at the same moment).
export interface PositionFill {
  fillId: string;
  source: string;
  sessionId: string | null;
  listingId: number;
  accountId: number | null;
  recordedAt: Date;
  price: bigint | null;
  before: PositionState;
  after: PositionState;
  // What this row itself realized and paid: only a manual trade or a settlement carries its own amounts.
  realized: bigint;
  fees: bigint;
  mark: MarkInputs | null;
}

const POSITION_FILL = `
  SELECT f.fill_id, f.source, f.session_id, f.listing_id, f.account_id, f.recorded_at, f.fill_price,
    f.net_quantity_after, f.total_cost_after, f.realized_pnl_after, f.fees_after,
    prev.net_quantity_after AS before_net, prev.total_cost_after AS before_cost, mk.bid, mk.ask, mk.last_trade
  FROM ledger.fill f
  LEFT JOIN LATERAL (
    SELECT net_quantity_after, total_cost_after FROM ledger.fill p
    WHERE p.strategy_id = f.strategy_id AND p.listing_id = f.listing_id AND p.mode = f.mode
      AND p.account_id IS NOT DISTINCT FROM f.account_id AND p.source <> 'GAP' AND p.fill_id < f.fill_id
    ORDER BY p.fill_id DESC LIMIT 1
  ) prev ON TRUE
  LEFT JOIN LATERAL (
    SELECT bid, ask, last_trade FROM ledger.mark m
    WHERE m.listing_id = f.listing_id AND m.ts < f.recorded_at ORDER BY m.ts DESC LIMIT 1
  ) mk ON TRUE`;

function positionFill(r: Record<string, any>): PositionFill {
  const own = r.source === 'MANUAL' || r.source === 'SETTLEMENT';
  return {
    fillId: String(r.fill_id),
    source: r.source,
    sessionId: r.session_id,
    listingId: r.listing_id,
    accountId: r.account_id,
    recordedAt: r.recorded_at,
    price: r.fill_price === null ? null : toBigInt(r.fill_price),
    before: position(r.before_net, r.before_cost),
    after: position(r.net_quantity_after, r.total_cost_after),
    realized: own ? toBigInt(r.realized_pnl_after) : 0n,
    fees: own ? toBigInt(r.fees_after) : 0n,
    mark: toMark(r),
  };
}

export async function loadOutOfSessionFills(
  client: PoolClient, mode: string, strategyId: number, at: Date,
): Promise<PositionFill[]> {
  const rows = (await client.query(`${POSITION_FILL}
    WHERE f.mode = $1 AND f.strategy_id = $2 AND f.recorded_at <= $3 AND f.source = ANY($4::text[])
    ORDER BY f.fill_id`, [mode, strategyId, at, OUT_OF_SESSION_SOURCES])).rows;
  return rows.map(positionFill);
}

// What became of a position a stopped session left open: the first thing to touch it afterwards, a later session
// holding it (whether or not it traded), or, if nothing has yet, whether its market is still to settle. Only for
// reading: none of it counts in the session's PnL.
export interface AfterSession {
  fill: PositionFill | null;
  nextSessionId: string | null;
  nextSessionStartedAt: Date | null;
  // Set for a prediction-market outcome; settlementPrice stays null until its result is recorded.
  eventContract: boolean;
  settlementPrice: bigint | null;
}

// One query for every listing a session left open, however many it traded: each gets the answer in input order.
export async function loadAfterSessions(client: PoolClient, states: SessionListingState[]): Promise<AfterSession[]> {
  if (states.length === 0) return [];
  const rows = (await client.query(`
    SELECT q.ord, nf.fill_id AS next_fill_id, next.session_id AS next_session_id, next.started_at AS next_started_at,
      ec.event_contract_id IS NOT NULL AS event_contract, ec.settlement_price
    FROM unnest($1::text[], $2::int[], $3::text[], $4::int[], $5::timestamptz[])
      WITH ORDINALITY AS q(session_id, strategy_id, mode, listing_id, started_at, ord)
    LEFT JOIN LATERAL (
      SELECT sva.account_id FROM sm.listing ll
      JOIN account_master.session_venue_account sva ON sva.exchange_id = ll.exchange_id AND sva.session_id = q.session_id
      WHERE ll.listing_id = q.listing_id
    ) acct ON TRUE
    LEFT JOIN LATERAL (
      SELECT f.fill_id FROM ledger.fill f
      WHERE f.strategy_id = q.strategy_id AND f.mode = q.mode AND f.listing_id = q.listing_id AND f.source <> 'GAP'
        AND f.account_id IS NOT DISTINCT FROM acct.account_id
        AND f.session_id IS DISTINCT FROM q.session_id AND f.recorded_at >= q.started_at
      ORDER BY f.fill_id LIMIT 1
    ) nf ON TRUE
    LEFT JOIN LATERAL (
      SELECT s.session_id, s.started_at FROM strategy.session_listing sl
      JOIN strategy.session s ON s.session_id = sl.session_id
      JOIN sm.listing l ON l.listing_id = sl.listing_id
      LEFT JOIN account_master.session_venue_account sva
        ON sva.session_id = s.session_id AND sva.exchange_id = l.exchange_id
      WHERE sl.strategy_id = q.strategy_id AND sl.mode = q.mode AND sl.listing_id = q.listing_id
        AND s.session_id <> q.session_id AND s.started_at > q.started_at
        AND sva.account_id IS NOT DISTINCT FROM acct.account_id
      ORDER BY s.started_at LIMIT 1
    ) next ON TRUE
    LEFT JOIN sm.listing l ON l.listing_id = q.listing_id
    LEFT JOIN sm.event_contract ec ON ec.security_id = l.security_id
    ORDER BY q.ord`,
  [states.map(s => s.sessionId), states.map(s => s.strategyId), states.map(s => s.mode), states.map(s => s.listingId),
    states.map(s => s.startedAt)])).rows;
  const fillIds = rows.filter(r => r.next_fill_id !== null).map(r => String(r.next_fill_id));
  const fills = new Map(fillIds.length === 0 ? [] : (await client.query(
    `${POSITION_FILL} WHERE f.fill_id = ANY($1::bigint[])`, [fillIds])).rows.map(r => [String(r.fill_id), positionFill(r)]));
  return rows.map(r => ({
    fill: r.next_fill_id === null ? null : fills.get(String(r.next_fill_id)) ?? null,
    nextSessionId: r.next_session_id,
    nextSessionStartedAt: r.next_started_at,
    eventContract: r.event_contract,
    settlementPrice: r.settlement_price === null ? null : toBigInt(r.settlement_price),
  }));
}

// The start of the day containing `at` in a time zone (an IANA name such as UTC or America/New_York).
export async function startOfDay(client: PoolClient, at: Date, timeZone: string): Promise<Date> {
  const result = await client.query(
    `SELECT (date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AS start`, [at, timeZone]);
  return result.rows[0].start;
}
