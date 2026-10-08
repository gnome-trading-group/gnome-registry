import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { getActor, withTransaction } from './base';
import { connectLedgerDatabase, createResponse, isPositiveInt, parseMode } from './ledger-common';
import { applyTrade, toBigInt, Trade } from './ledger-math';

// An operator changing what a strategy holds on a listing, refused while any session of the strategy holds the
// listing so it can never race a running OMS. Either:
//   a trade      one made outside any session (closing by hand on the venue), booked as a MANUAL fill: it moves the
//                position as a fill would and realizes PnL against the average entry
//   a correction setting the position outright (ADJUSTMENT), for a ledger that was wrong; it realizes nothing, so
//                any unrealized PnL on what it removes is written off
interface IAdjustment {
  strategyId: number;
  listingId: number;
  mode: string;
  netQuantity?: string | number;
  totalCost?: string | number;
  trade?: { side: number; qty: string | number; price: string | number; fee?: string | number };
  reason: string;
}

type Change =
  | { kind: 'trade'; trade: Trade }
  | { kind: 'correction'; netQuantity: bigint; totalCost: bigint };

function scaledInt(name: string, value: unknown): bigint {
  if (value === undefined || value === null || !/^-?\d+$/.test(String(value))) {
    throw new Error(`${name} must be an integer in its scaled units`);
  }
  return BigInt(String(value));
}

export function parseAdjustment(body: string) {
  const a = JSON.parse(body) as IAdjustment;
  if (!isPositiveInt(a.strategyId) || !isPositiveInt(a.listingId)) {
    throw new Error('strategyId and listingId must be positive integers');
  }
  const mode = parseMode(a.mode);
  if (!mode) throw new Error('mode is required');
  if (typeof a.reason !== 'string' || a.reason.trim().length === 0) throw new Error('reason is required');
  const isTrade = a.trade !== undefined;
  if (isTrade === (a.netQuantity !== undefined || a.totalCost !== undefined)) {
    throw new Error('give either a trade or a netQuantity and totalCost');
  }
  let change: Change;
  if (a.trade) {
    if (a.trade.side !== 0 && a.trade.side !== 1) throw new Error('trade.side must be 0 (buy) or 1 (sell)');
    const trade: Trade = {
      side: a.trade.side,
      qty: scaledInt('trade.qty', a.trade.qty),
      price: scaledInt('trade.price', a.trade.price),
      fee: a.trade.fee === undefined ? 0n : scaledInt('trade.fee', a.trade.fee),
    };
    if (trade.qty <= 0n) throw new Error('trade.qty must be positive');
    if (trade.price < 0n) throw new Error('trade.price must not be negative');
    change = { kind: 'trade', trade };
  } else {
    const netQuantity = scaledInt('netQuantity', a.netQuantity);
    const totalCost = scaledInt('totalCost', a.totalCost);
    if (totalCost < 0n) throw new Error('totalCost must not be negative');
    if (netQuantity === 0n && totalCost !== 0n) throw new Error('a flat position has no cost');
    change = { kind: 'correction', netQuantity, totalCost };
  }
  return { strategyId: a.strategyId, listingId: a.listingId, mode, reason: a.reason, change };
}

export class ConflictError extends Error {}

type Holding = { netQuantity: bigint; totalCost: bigint; version: bigint };

// Refuses while any session of the strategy holds the listing, then locks the position so nothing else moves it
// before the caller's transaction commits.
async function lockUnheldPosition(c: PoolClient, strategyId: number, listingId: number, mode: string): Promise<Holding> {
  const held = await c.query(
    `SELECT session_id FROM strategy.session_listing
     WHERE strategy_id = $1 AND mode = $2 AND listing_id = $3 AND active`,
    [strategyId, mode, listingId]);
  if (held.rowCount && held.rowCount > 0) {
    throw new ConflictError(`Session ${held.rows[0].session_id} holds this listing; stop it first`);
  }
  const current = await c.query(
    `SELECT net_quantity, total_cost, version FROM ledger.position
     WHERE strategy_id = $1 AND listing_id = $2 AND mode = $3 FOR UPDATE`,
    [strategyId, listingId, mode]);
  return {
    netQuantity: toBigInt(current.rows[0]?.net_quantity),
    totalCost: toBigInt(current.rows[0]?.total_cost),
    version: BigInt(current.rows[0]?.version ?? 0),
  };
}

async function upsertPosition(c: PoolClient, strategyId: number, listingId: number, mode: string,
  after: { netQuantity: bigint; totalCost: bigint }, version: bigint) {
  const result = await c.query(
    `INSERT INTO ledger.position (strategy_id, listing_id, mode, net_quantity, total_cost, version, needs_review)
     VALUES ($1, $2, $3, $4, $5, $6, FALSE)
     ON CONFLICT (strategy_id, listing_id, mode) DO UPDATE SET net_quantity = EXCLUDED.net_quantity,
       total_cost = EXCLUDED.total_cost, version = EXCLUDED.version, session_id = NULL, needs_review = FALSE,
       updated_at = NOW()
     WHERE ledger.position.version < EXCLUDED.version
     RETURNING *`,
    [strategyId, listingId, mode, after.netQuantity.toString(), after.totalCost.toString(), version.toString()]);
  return result.rows[0];
}

// A trade made outside any session, applied inside the caller's transaction: an operator's MANUAL trade, or the
// settlement sweeper closing a settled position (SETTLEMENT). Returns the position after it.
export interface IBookedTrade {
  strategyId: number;
  listingId: number;
  mode: string;
  trade: Trade;
  actor: string;
  reason: string;
  source: 'MANUAL' | 'SETTLEMENT';
  // Books nothing unless the position still holds this, for a caller that decided on a quantity read earlier.
  expectedNetQuantity?: bigint;
}

export async function bookTrade(c: PoolClient, booked: IBookedTrade) {
  const { strategyId, listingId, mode, trade } = booked;
  const holding = await lockUnheldPosition(c, strategyId, listingId, mode);
  if (booked.expectedNetQuantity !== undefined && holding.netQuantity !== booked.expectedNetQuantity) {
    throw new ConflictError(`Position is ${holding.netQuantity}, not the ${booked.expectedNetQuantity} expected`);
  }
  const version = holding.version + 1n;
  const traded = applyTrade(holding, trade);
  await c.query(
    `INSERT INTO ledger.fill (source, strategy_id, listing_id, mode, side, fill_qty, fill_price, fee,
       net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version, actor, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $8, $12, $13, $14)`,
    [booked.source, strategyId, listingId, mode, trade.side, trade.qty.toString(), trade.price.toString(),
      trade.fee.toString(), traded.netQuantity.toString(), traded.totalCost.toString(), traded.realized.toString(),
      version.toString(), booked.actor, booked.reason]);
  return upsertPosition(c, strategyId, listingId, mode, traded, version);
}

// Applies an adjustment inside the caller's transaction, returning the position after it.
export async function bookAdjustment(c: PoolClient, adjustment: ReturnType<typeof parseAdjustment>, actor: string) {
  const { strategyId, listingId, mode, change, reason } = adjustment;
  if (change.kind === 'trade') {
    return bookTrade(c, { strategyId, listingId, mode, trade: change.trade, actor, reason, source: 'MANUAL' });
  }
  const holding = await lockUnheldPosition(c, strategyId, listingId, mode);
  const version = holding.version + 1n;
  await c.query(
    `INSERT INTO ledger.fill (source, strategy_id, listing_id, mode, net_quantity_after, total_cost_after,
       position_version, actor, reason)
     VALUES ('ADJUSTMENT', $1, $2, $3, $4, $5, $6, $7, $8)`,
    [strategyId, listingId, mode, change.netQuantity.toString(), change.totalCost.toString(), version.toString(),
      actor, reason]);
  return upsertPosition(c, strategyId, listingId, mode, change, version);
}

export const handler = async (event: APIGatewayProxyEvent) => {
  if (event.httpMethod !== 'POST') return createResponse(400, { message: 'Invalid HTTP method' });
  let adjustment;
  try {
    adjustment = parseAdjustment(event.body ?? '');
  } catch (error) {
    return createResponse(400, { message: error instanceof Error ? error.message : String(error) });
  }
  const actor = getActor(event);

  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const row = await withTransaction(client, (c) => bookAdjustment(c, adjustment, actor));
    return createResponse(200, row);
  } catch (error) {
    if (error instanceof ConflictError) return createResponse(409, { message: error.message });
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
