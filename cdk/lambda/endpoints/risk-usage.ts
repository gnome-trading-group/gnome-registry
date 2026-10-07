import { APIGatewayProxyEvent } from 'aws-lambda';
import { PoolClient } from 'pg';
import { connectLedgerDatabase, createResponse, isSessionId } from './ledger-common';
import { pnl, toBigInt } from './ledger-math';
import { loadListingInfo, loadSessionStates } from './pnl-state';

// How close a running session is to each risk limit that applies to it, measured as its OMS measures it (see the
// policies in gnome-oms risk/policy). Each session's OMS enforces its own limits over its own positions, so usage is
// per session. Read from the ledger, which trails the OMS by a few hundred milliseconds.
//   MAX_POSITION        the worst case if every open order on one side filled: |net + buys| or |net - sells|.
//                       Checked against each order's own listing, so a policy without a listing binds on the
//                       session's closest listing.
//   MAX_OPEN_ORDERS     open orders on the policy's listing, or across the session's listings
//   MAX_TOTAL_PNL_LOSS  the loss (realized + unrealized - fees, this session's own realized PnL and fees, inherited
//                       inventory at its original cost), on the policy's listing or across the session's listings
//   MAX_ORDER_SIZE, MAX_NOTIONAL, PRICE_COLLAR  judge each order alone, so they have no running usage
// Values and limits are scaled-integer strings in each policy's own units.

const PER_ORDER: Record<string, string> = {
  MAX_ORDER_SIZE: 'maxOrderSize',
  MAX_NOTIONAL: 'maxNotionalValue',
  PRICE_COLLAR: 'maxDeviation',
};

interface ListingState {
  net: bigint;
  leavesBuy: bigint;
  leavesSell: bigint;
  openOrders: number;
  pnl: bigint;
}

export interface PolicyUsage {
  policyId: number;
  policyType: string;
  level: 'session' | 'strategy' | 'listing' | 'global';
  listingId: number | null;
  limit: string;
  value: string | null;
  // value / limit; null for a per-order policy.
  usage: number | null;
  perOrder: boolean;
  // The listing the usage was measured on, when a policy without a listing binds on one.
  bindingListingId: number | null;
  bindingSymbol: string | null;
}

function level(row: { session_id: string | null; strategy_id: number | null; listing_id: number | null }): PolicyUsage['level'] {
  if (row.session_id !== null) return 'session';
  if (row.strategy_id !== null) return 'strategy';
  return row.listing_id !== null ? 'listing' : 'global';
}

function ratio(value: bigint, limit: bigint): number {
  if (limit <= 0n) return value > 0n ? Infinity : 0;
  return Number((value * 1_000_000n) / limit) / 1_000_000;
}

export async function riskUsage(client: PoolClient, sessionId: string, now: Date) {
  const session = (await client.query(
    'SELECT strategy_id, status FROM strategy.session WHERE session_id = $1', [sessionId])).rows[0];
  if (!session) return null;
  const states = await loadSessionStates(client, [sessionId], now);
  const listingIds = states.map(s => s.listingId);
  const info = await loadListingInfo(client, listingIds);

  // Working orders and what is left of each; an order counts from when it was sent until it closes, as in the OMS.
  const open = (await client.query(`
    SELECT o.listing_id, o.side, count(*)::int AS orders,
      SUM(GREATEST(COALESCE(o.size, 0) - COALESCE(f.filled, 0), 0)) AS leaves
    FROM ledger.order o
    LEFT JOIN LATERAL (
      SELECT MAX(cum_qty_after) AS filled FROM ledger.fill
      WHERE source = 'VENUE' AND session_id = o.session_id AND client_oid_counter = o.client_oid_counter
    ) f ON TRUE
    WHERE o.session_id = $1 AND o.status = 'OPEN'
    GROUP BY o.listing_id, o.side`, [sessionId])).rows;

  const byListing = new Map<number, ListingState>();
  for (const s of states) {
    byListing.set(s.listingId, {
      net: s.current.netQuantity, leavesBuy: 0n, leavesSell: 0n, openOrders: 0,
      pnl: pnl(s.current, s.mark).totalPnl,
    });
  }
  for (const o of open) {
    const state = byListing.get(o.listing_id);
    if (!state) continue;
    state.openOrders += o.orders;
    if (o.side === 0) state.leavesBuy += toBigInt(o.leaves);
    else state.leavesSell += toBigInt(o.leaves);
  }
  const worstCase = (s: ListingState) => {
    const buys = s.net + s.leavesBuy;
    const sells = s.net - s.leavesSell;
    const abs = (v: bigint) => (v < 0n ? -v : v);
    return abs(buys) > abs(sells) ? abs(buys) : abs(sells);
  };

  const policies = (await client.query(`
    SELECT policy_id, policy_type, session_id, strategy_id, listing_id, parameters FROM risk.policy
    WHERE enabled AND policy_type <> 'KILL_SWITCH'
      AND (session_id IS NULL OR session_id = $1)
      AND (strategy_id IS NULL OR strategy_id = $2)
      AND (listing_id IS NULL OR listing_id = ANY($3::int[]))
    ORDER BY policy_id`, [sessionId, session.strategy_id, listingIds])).rows;
  const refused = (await client.query(`
    SELECT COALESCE(SUM(count), 0)::bigint AS refused FROM ledger.reject_count
    WHERE session_id = $1 AND reason = 'RISK_LIMIT_EXCEEDED'`, [sessionId])).rows[0].refused;

  const usages: PolicyUsage[] = [];
  for (const p of policies) {
    const base = {
      policyId: p.policy_id, policyType: p.policy_type, level: level(p), listingId: p.listing_id,
      bindingListingId: null as number | null, bindingSymbol: null as string | null,
    };
    if (PER_ORDER[p.policy_type]) {
      usages.push({ ...base, limit: String(p.parameters[PER_ORDER[p.policy_type]] ?? 0), value: null, usage: null, perOrder: true });
      continue;
    }
    const scope = p.listing_id !== null ? [p.listing_id] : listingIds;
    const states = scope.map(id => [id, byListing.get(id)] as const).filter((e): e is readonly [number, ListingState] => !!e[1]);
    let limit: bigint;
    let value = 0n;
    let binding: number | null = null;
    if (p.policy_type === 'MAX_POSITION') {
      limit = toBigInt(p.parameters.maxPosition);
      for (const [id, s] of states) {
        const worst = worstCase(s);
        if (binding === null || worst > value) {
          value = worst;
          binding = id;
        }
      }
    } else if (p.policy_type === 'MAX_OPEN_ORDERS') {
      limit = toBigInt(p.parameters.maxOpenOrders);
      value = BigInt(states.reduce((sum, [, s]) => sum + s.openOrders, 0));
    } else if (p.policy_type === 'MAX_TOTAL_PNL_LOSS') {
      limit = toBigInt(p.parameters.maxLoss);
      const total = states.reduce((sum, [, s]) => sum + s.pnl, 0n);
      value = total < 0n ? -total : 0n;
    } else {
      continue;
    }
    usages.push({
      ...base, limit: limit.toString(), value: value.toString(), usage: ratio(value, limit), perOrder: false,
      bindingListingId: p.listing_id === null ? binding : null,
      bindingSymbol: p.listing_id === null && binding !== null ? info.get(binding)?.symbol ?? null : null,
    });
  }
  // Closest to a limit first; per-order policies after.
  usages.sort((a, b) => (b.usage ?? -1) - (a.usage ?? -1) || a.policyId - b.policyId);
  return { sessionId, asOf: now.toISOString(), status: session.status, refusedByRisk: Number(refused), policies: usages };
}

export const handler = async (event: APIGatewayProxyEvent) => {
  const sessionId = event.queryStringParameters?.sessionId;
  if (!isSessionId(sessionId)) return createResponse(400, { message: 'sessionId is required' });
  const pool = await connectLedgerDatabase();
  const client = await pool.connect();
  try {
    const usage = await riskUsage(client, sessionId, new Date());
    return usage === null ? createResponse(404, { message: 'No such session' }) : createResponse(200, usage);
  } catch (error) {
    console.error('Risk usage error:', error);
    return createResponse(500, { message: error instanceof Error ? error.message : String(error) });
  } finally {
    client.release();
  }
};
