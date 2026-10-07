import { markPrice, MarkInputs, notional, pnl, PositionState } from './ledger-math';

// PnL as the controller shows it, built on the OMS's own valuation (ledger-math). Money is in price units.
//
// A session's PnL is what changed while it ran: it starts at $0 even when the session inherited inventory, so the
// gains that inventory made before the session existed belong to the sessions that held it then.
//   carry   what the inherited inventory made as if held untouched: its quantity times the mark's move since the
//           session started
//   trading everything else

export interface SessionPnlInputs {
  // The strategy's position on the listing just before the session started (flat if it chose not to inherit).
  opening: PositionState;
  openingMark: MarkInputs | null;
  // The position now, with the session's own realized PnL and fees.
  current: PositionState;
  mark: MarkInputs | null;
}

export interface SessionPnl {
  total: bigint;
  realized: bigint;
  unrealized: bigint;
  fees: bigint;
  carry: bigint;
  trading: bigint;
  openingUnrealized: bigint;
  // Inherited inventory with no mark when the session started is valued at its entry (the OMS's rule), so its
  // earlier gains or losses land in this session's PnL.
  openingMarkMissing: boolean;
}

export function sessionPnl(inputs: SessionPnlInputs): SessionPnl {
  const now = pnl(inputs.current, inputs.mark);
  const openingUnrealized = pnl(inputs.opening, inputs.openingMark).unrealizedPnl;
  const total = inputs.current.realizedPnl + now.unrealizedPnl - inputs.current.totalFees - openingUnrealized;
  const startPrice = markPrice(inputs.openingMark);
  const nowPrice = markPrice(inputs.mark);
  const carry = startPrice === 0n || nowPrice === 0n ? 0n : notional(nowPrice - startPrice, inputs.opening.netQuantity);
  return {
    total,
    realized: inputs.current.realizedPnl,
    unrealized: now.unrealizedPnl,
    fees: inputs.current.totalFees,
    carry,
    trading: total - carry,
    openingUnrealized,
    openingMarkMissing: inputs.opening.netQuantity !== 0n && startPrice === 0n,
  };
}

// A strategy's PnL over its whole life on a listing: every session's realized PnL and fees, plus the unrealized PnL
// of what it holds now. Cost basis carries across sessions, so this is continuous across relaunches.
export interface LifetimePnl {
  total: bigint;
  realized: bigint;
  unrealized: bigint;
  fees: bigint;
}

export function lifetimePnl(position: PositionState, mark: MarkInputs | null): LifetimePnl {
  const valued = pnl(position, mark);
  return {
    total: valued.totalPnl,
    realized: position.realizedPnl,
    unrealized: valued.unrealizedPnl,
    fees: position.totalFees,
  };
}

// Chart resolutions, smallest first; a series uses the smallest that keeps it within MAX_POINTS.
export const RESOLUTIONS_MS = [
  1_000, 5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000, 14_400_000, 86_400_000,
];
export const MAX_POINTS = 1500;

export function pickResolution(spanMs: number, requestedMs?: number): number {
  const fits = (step: number) => Math.ceil(spanMs / step) <= MAX_POINTS;
  if (requestedMs !== undefined && fits(requestedMs)) return requestedMs;
  return RESOLUTIONS_MS.find(fits) ?? RESOLUTIONS_MS[RESOLUTIONS_MS.length - 1];
}

// Point times for a window: its start, each multiple of the step inside it (aligned to the epoch, so polling with
// `since` lands on the same points), then its end.
export function pointTimes(fromMs: number, toMs: number, stepMs: number): number[] {
  const times = [fromMs];
  for (let t = Math.floor(fromMs / stepMs) * stepMs + stepMs; t < toMs; t += stepMs) times.push(t);
  if (toMs > fromMs) times.push(toMs);
  return times;
}
