import { PoolClient } from 'pg';
import { connectDatabase } from '../connections';
import { withTransaction } from '../endpoints/base';
import { bookTrade, ConflictError } from '../endpoints/ledger-adjustments';
import { WRITABLE_SESSION_STATUSES } from '../endpoints/ledger-common';
import { abs } from '../endpoints/ledger-math';

const ACTOR = 'settlement-sweeper';
const PRICE_SCALE = 1_000_000_000n;

// Positions still open on a listing whose outcome has settled, that no session holds. A held position is left to
// its session's OMS, which owns it until the session ends and releases the lease; a position under review is left
// to an operator, since closing an untrusted quantity would book untrusted PnL.
const FIND_SETTLED_POSITIONS = `
  SELECT p.strategy_id, p.listing_id, p.mode, p.net_quantity, ec.settlement_price
  FROM ledger.position p
  JOIN sm.listing l ON l.listing_id = p.listing_id
  JOIN LATERAL (
    SELECT settlement_price FROM sm.event_contract
    WHERE security_id = l.security_id AND settlement_price IS NOT NULL LIMIT 1
  ) ec ON TRUE
  WHERE p.net_quantity <> 0 AND NOT p.needs_review
    AND NOT EXISTS (
      SELECT 1 FROM strategy.session_listing sl
      WHERE sl.strategy_id = p.strategy_id AND sl.mode = p.mode AND sl.listing_id = p.listing_id AND sl.active)
  ORDER BY p.strategy_id, p.listing_id, p.mode`;

// Orders an ended session left resting died with the market. Only an ended session's orders are touched, as when a
// starting session recovers them, so a running session's orders stay its own.
const EXPIRE_SETTLED_ORDERS = `
  UPDATE ledger.order o SET status = 'CLOSED', close_state = 'EXPIRED', closed_at = NOW()
  FROM sm.listing l, strategy.session s
  WHERE o.status = 'OPEN' AND l.listing_id = o.listing_id AND s.session_id = o.session_id
    AND s.status <> ALL($1::text[])
    AND EXISTS (SELECT 1 FROM sm.event_contract ec WHERE ec.security_id = l.security_id AND ec.settlement_price IS NOT NULL)
  RETURNING o.session_id, o.client_oid_counter, o.listing_id`;

export interface SweepResult {
  booked: number;
  skipped: number;
  failed: number;
  ordersExpired: number;
}

export function formatPrice(price: bigint): string {
  const fraction = (price % PRICE_SCALE).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${price / PRICE_SCALE}.${fraction}` : `${price / PRICE_SCALE}`;
}

export async function sweepSettlements(client: PoolClient): Promise<SweepResult> {
  const result: SweepResult = { booked: 0, skipped: 0, failed: 0, ordersExpired: 0 };
  const candidates = (await client.query(FIND_SETTLED_POSITIONS)).rows;
  for (const row of candidates) {
    const net = BigInt(row.net_quantity);
    const price = BigInt(row.settlement_price);
    const label = `strategy ${row.strategy_id} listing ${row.listing_id} ${row.mode}`;
    try {
      const position = await withTransaction(client, (c) => bookTrade(c, {
        strategyId: row.strategy_id,
        listingId: row.listing_id,
        mode: row.mode,
        trade: { side: net > 0n ? 1 : 0, qty: abs(net), price, fee: 0n },
        expectedNetQuantity: net,
        actor: ACTOR,
        reason: `market settled at ${formatPrice(price)}`,
        source: 'SETTLEMENT',
      }));
      result.booked++;
      console.log(`Settled ${label}: closed ${net} at ${formatPrice(price)} (position version ${position?.version})`);
    } catch (error) {
      if (error instanceof ConflictError) {
        // A session took the listing, or the position moved, after the candidates were read; the next sweep
        // looks again.
        result.skipped++;
        console.log(`Skipped ${label}: ${error.message}`);
      } else if ((error as { constraint?: string })?.constraint === 'idx_fill_settlement') {
        // The position was settled once and reopened, which only a market re-opening after settlement could do.
        result.skipped++;
        console.warn(`Skipped ${label}: already booked a settlement, yet holds ${net} again`);
      } else {
        result.failed++;
        console.error(`Failed to settle ${label}:`, error);
      }
    }
  }
  const expired = await client.query(EXPIRE_SETTLED_ORDERS, [WRITABLE_SESSION_STATUSES]);
  result.ordersExpired = expired.rowCount ?? 0;
  for (const order of expired.rows) {
    console.log(`Expired order ${order.session_id}/${order.client_oid_counter} on settled listing ${order.listing_id}`);
  }
  return result;
}

export const handler = async () => {
  const pool = await connectDatabase();
  const client = await pool.connect();
  try {
    const result = await sweepSettlements(client);
    console.log('Settlement sweep:', JSON.stringify(result));
    if (result.failed > 0) {
      // Fails the invocation so the Lambda error alarm fires; the next sweep retries every unbooked position.
      throw new Error(`${result.failed} settlement(s) failed to book`);
    }
    return result;
  } finally {
    client.release();
  }
};
