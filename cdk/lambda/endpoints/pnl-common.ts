import { MarkInputs, pnl, PositionState, toBigInt } from './ledger-math';

// PnL rows in the shape the controller reads (one per listing per point in time). Every value is derived from the
// ledger's fills and marks; nothing here is stored.
export interface PnlRow {
  snapshot_id: string;
  strategy_id: number;
  session_id: string | null;
  listing_id: number;
  mode: string;
  net_quantity: string;
  avg_entry_price: string;
  mark_price: string;
  realized_pnl: string;
  unrealized_pnl: string;
  total_fees: string;
  total_pnl: string;
  leaves_buy_qty: string;
  leaves_sell_qty: string;
  snapshot_time: string;
}

export function toMark(row: { bid?: unknown; ask?: unknown; last_trade?: unknown } | null | undefined): MarkInputs | null {
  if (!row || row.bid === null || row.bid === undefined) return null;
  return { bid: toBigInt(row.bid), ask: toBigInt(row.ask), lastTrade: toBigInt(row.last_trade) };
}

export function pnlRow(
  key: { strategyId: number; sessionId: string | null; listingId: number; mode: string; time: Date },
  position: PositionState,
  mark: MarkInputs | null,
): PnlRow {
  const derived = pnl(position, mark);
  return {
    snapshot_id: `${key.sessionId ?? key.strategyId}-${key.listingId}-${key.time.getTime()}`,
    strategy_id: key.strategyId,
    session_id: key.sessionId,
    listing_id: key.listingId,
    mode: key.mode,
    net_quantity: position.netQuantity.toString(),
    avg_entry_price: derived.avgEntryPrice.toString(),
    mark_price: derived.markPrice.toString(),
    realized_pnl: position.realizedPnl.toString(),
    unrealized_pnl: derived.unrealizedPnl.toString(),
    total_fees: position.totalFees.toString(),
    total_pnl: derived.totalPnl.toString(),
    leaves_buy_qty: '0',
    leaves_sell_qty: '0',
    snapshot_time: key.time.toISOString(),
  };
}
