import { APIGatewayProxyEvent } from 'aws-lambda';
import { getActor, withTransaction } from './base';
import { connectLedgerDatabase, createResponse, isPositiveInt, parseMode } from './ledger-common';

// An operator setting what a strategy holds on a listing: correcting a position the ledger can't trust, or booking a
// market's settlement (setting it to flat). Refused while any session of the strategy holds the listing, so it can
// never race a running OMS.
interface IAdjustment {
  strategyId: number;
  listingId: number;
  mode: string;
  netQuantity: string | number;
  totalCost: string | number;
  reason: string;
}

class ConflictError extends Error {}

function parseAdjustment(body: string): IAdjustment & { mode: 'paper' | 'live' } {
  const a = JSON.parse(body) as IAdjustment;
  if (!isPositiveInt(a.strategyId) || !isPositiveInt(a.listingId)) {
    throw new Error('strategyId and listingId must be positive integers');
  }
  const mode = parseMode(a.mode);
  if (!mode) throw new Error('mode is required');
  for (const [name, value] of [['netQuantity', a.netQuantity], ['totalCost', a.totalCost]] as const) {
    if (value === undefined || value === null || !/^-?\d+$/.test(String(value))) {
      throw new Error(`${name} must be an integer in its scaled units`);
    }
  }
  if (BigInt(a.totalCost) < 0n) throw new Error('totalCost must not be negative');
  if (BigInt(a.netQuantity) === 0n && BigInt(a.totalCost) !== 0n) throw new Error('a flat position has no cost');
  if (typeof a.reason !== 'string' || a.reason.trim().length === 0) throw new Error('reason is required');
  return { ...a, mode };
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
    const row = await withTransaction(client, async (c) => {
      const held = await c.query(
        `SELECT session_id FROM strategy.session_listing
         WHERE strategy_id = $1 AND mode = $2 AND listing_id = $3 AND active`,
        [adjustment.strategyId, adjustment.mode, adjustment.listingId]);
      if (held.rowCount && held.rowCount > 0) {
        throw new ConflictError(`Session ${held.rows[0].session_id} holds this listing; stop it first`);
      }
      const current = await c.query(
        `SELECT version FROM ledger.position WHERE strategy_id = $1 AND listing_id = $2 AND mode = $3 FOR UPDATE`,
        [adjustment.strategyId, adjustment.listingId, adjustment.mode]);
      const version = BigInt(current.rows[0]?.version ?? 0) + 1n;
      await c.query(
        `INSERT INTO ledger.fill (source, strategy_id, listing_id, mode, net_quantity_after, total_cost_after,
           position_version, actor, reason)
         VALUES ('ADJUSTMENT', $1, $2, $3, $4, $5, $6, $7, $8)`,
        [adjustment.strategyId, adjustment.listingId, adjustment.mode, String(adjustment.netQuantity),
          String(adjustment.totalCost), version.toString(), actor, adjustment.reason]);
      const result = await c.query(
        `INSERT INTO ledger.position (strategy_id, listing_id, mode, net_quantity, total_cost, version, needs_review)
         VALUES ($1, $2, $3, $4, $5, $6, FALSE)
         ON CONFLICT (strategy_id, listing_id, mode) DO UPDATE SET net_quantity = EXCLUDED.net_quantity,
           total_cost = EXCLUDED.total_cost, version = EXCLUDED.version, session_id = NULL, needs_review = FALSE,
           updated_at = NOW()
         RETURNING *`,
        [adjustment.strategyId, adjustment.listingId, adjustment.mode, String(adjustment.netQuantity),
          String(adjustment.totalCost), version.toString()]);
      return result.rows[0];
    });
    return createResponse(200, row);
  } catch (error) {
    if (error instanceof ConflictError) return createResponse(409, { message: error.message });
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
