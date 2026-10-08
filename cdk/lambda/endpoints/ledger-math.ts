// PnL as the OMS computes it, so the registry's numbers match the risk limits exactly. Prices and money are in price
// units (1e9 per dollar), quantities in size units (1e6 per unit). Net quantity is signed (negative is short) and
// total cost is always positive. Integer division truncates toward zero, as ScaledMath.multiplyDivide does.
export const SIZE_SCALE = 1_000_000n;

export interface MarkInputs {
  bid: bigint;
  ask: bigint;
  lastTrade: bigint;
}

export interface PositionState {
  netQuantity: bigint;
  totalCost: bigint;
  realizedPnl: bigint;
  totalFees: bigint;
}

export interface Pnl {
  markPrice: bigint;
  avgEntryPrice: bigint;
  unrealizedPnl: bigint;
  totalPnl: bigint;
}

// SharedPriceBuffer.markPrice: the mid of a two-sided book, else the last trade; 0 means unknown.
export function markPrice(mark: MarkInputs | null): bigint {
  if (!mark) return 0n;
  if (mark.bid > 0n && mark.ask > 0n) return mark.bid + (mark.ask - mark.bid) / 2n;
  return mark.lastTrade;
}

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

export function notional(price: bigint, quantity: bigint): bigint {
  return (price * quantity) / SIZE_SCALE;
}

export function avgEntryPrice(position: PositionState): bigint {
  return position.netQuantity === 0n ? 0n : (position.totalCost * SIZE_SCALE) / abs(position.netQuantity);
}

// MaxTotalPnlLossPolicy: a leg with no mark is valued at its entry, so its unrealized PnL is 0.
export function pnl(position: PositionState, mark: MarkInputs | null): Pnl {
  const price = markPrice(mark);
  const entry = avgEntryPrice(position);
  const unrealized = price === 0n || position.netQuantity === 0n ? 0n : notional(price - entry, position.netQuantity);
  return {
    markPrice: price,
    avgEntryPrice: entry,
    unrealizedPnl: unrealized,
    totalPnl: position.realizedPnl + unrealized - position.totalFees,
  };
}

export function toBigInt(value: unknown): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  return BigInt(value as string | number);
}

// Position.applyFill: a trade of qty at price (side 0 buys, 1 sells) applied to a position. Closing realizes the
// difference from the average entry; a trade that flips the position opens the remainder at the trade's price.
export interface Trade {
  side: 0 | 1;
  qty: bigint;
  price: bigint;
  fee: bigint;
}

export function applyTrade(position: { netQuantity: bigint; totalCost: bigint }, trade: Trade): {
  netQuantity: bigint; totalCost: bigint; realized: bigint;
} {
  const signed = trade.side === 0 ? trade.qty : -trade.qty;
  const net = position.netQuantity;
  if (net === 0n) return { netQuantity: signed, totalCost: notional(trade.price, trade.qty), realized: 0n };
  if ((net > 0n) === (signed > 0n)) {
    return { netQuantity: net + signed, totalCost: position.totalCost + notional(trade.price, trade.qty), realized: 0n };
  }
  const closed = abs(net) < trade.qty ? abs(net) : trade.qty;
  const entry = avgEntryPrice({ ...position, realizedPnl: 0n, totalFees: 0n });
  const realized = net > 0n ? notional(trade.price - entry, closed) : notional(entry - trade.price, closed);
  const after = net + signed;
  const totalCost = after === 0n ? 0n
    : (after > 0n) !== (net > 0n) ? notional(trade.price, abs(after))
    : notional(entry, abs(after));
  return { netQuantity: after, totalCost, realized };
}
