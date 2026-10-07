import { applyTrade, avgEntryPrice, markPrice, pnl } from '../lambda/endpoints/ledger-math';

const DOLLAR = 1_000_000_000n;
const CENT = DOLLAR / 100n;
const UNIT = 1_000_000n;

function position(netQuantity: bigint, totalCost: bigint, realizedPnl = 0n, totalFees = 0n) {
  return { netQuantity, totalCost, realizedPnl, totalFees };
}

describe('ledger PnL matches the OMS', () => {
  it('marks at the mid, else the last trade, else unknown', () => {
    expect(markPrice({ bid: 30n * CENT, ask: 32n * CENT, lastTrade: 1n })).toBe(31n * CENT);
    expect(markPrice({ bid: 0n, ask: 32n * CENT, lastTrade: 29n * CENT })).toBe(29n * CENT);
    expect(markPrice(null)).toBe(0n);
  });

  it('values a long at the mark, net of fees', () => {
    // Bought 10 at 40c ($4.00), marked at 31c, $0.10 of fees.
    const result = pnl(position(10n * UNIT, 4n * DOLLAR, 0n, 10n * CENT), { bid: 30n * CENT, ask: 32n * CENT, lastTrade: 0n });
    expect(result.unrealizedPnl).toBe(-90n * CENT);
    expect(result.totalPnl).toBe(-DOLLAR);
  });

  it('a short gains when the mark falls', () => {
    // Sold 10 at 40c, marked at 31c.
    const result = pnl(position(-10n * UNIT, 4n * DOLLAR), { bid: 30n * CENT, ask: 32n * CENT, lastTrade: 0n });
    expect(result.unrealizedPnl).toBe(90n * CENT);
  });

  it('values a position flipped from long to short from its new entry', () => {
    // Long 10 at 40c, then sold 15 at 50c: $1.00 realized, short 5 at 50c, marked at 45c.
    const result = pnl(position(-5n * UNIT, 250n * CENT, DOLLAR), { bid: 44n * CENT, ask: 46n * CENT, lastTrade: 0n });
    expect(result.unrealizedPnl).toBe(25n * CENT);
    expect(result.totalPnl).toBe(125n * CENT);
  });

  it('values a leg with no mark at its entry', () => {
    expect(pnl(position(10n * UNIT, 4n * DOLLAR, -5n * CENT), null).totalPnl).toBe(-5n * CENT);
  });

  it('truncates toward zero like ScaledMath', () => {
    expect(avgEntryPrice(position(3n * UNIT, DOLLAR))).toBe(333_333_333n);
    expect(pnl(position(-3n * UNIT, DOLLAR), { bid: 0n, ask: 0n, lastTrade: 1n }).unrealizedPnl)
      .toBe(((1n - 333_333_333n) * -3n * UNIT) / UNIT);
  });
});

describe('a trade booked by hand moves the position as Position.applyFill does', () => {
  const held = (netQuantity: bigint, totalCost: bigint) => ({ netQuantity, totalCost });
  const sell = (qty: bigint, price: bigint) => ({ side: 1 as const, qty, price, fee: 0n });
  const buy = (qty: bigint, price: bigint) => ({ side: 0 as const, qty, price, fee: 0n });

  it('closing a long realizes the move from its average entry', () => {
    expect(applyTrade(held(10n * UNIT, 400n * CENT), sell(10n * UNIT, 55n * CENT)))
      .toEqual({ netQuantity: 0n, totalCost: 0n, realized: 150n * CENT });
  });

  it('a partial close keeps the rest at its entry', () => {
    expect(applyTrade(held(10n * UNIT, 400n * CENT), sell(4n * UNIT, 30n * CENT)))
      .toEqual({ netQuantity: 6n * UNIT, totalCost: 240n * CENT, realized: -40n * CENT });
  });

  it('closing a short gains when bought back lower', () => {
    expect(applyTrade(held(-5n * UNIT, 300n * CENT), buy(5n * UNIT, 50n * CENT)))
      .toEqual({ netQuantity: 0n, totalCost: 0n, realized: 50n * CENT });
  });

  it('a trade past flat closes the position and opens the rest at its price', () => {
    expect(applyTrade(held(2n * UNIT, 80n * CENT), sell(5n * UNIT, 50n * CENT)))
      .toEqual({ netQuantity: -3n * UNIT, totalCost: 150n * CENT, realized: 20n * CENT });
  });

  it('adding to a position, or trading from flat, realizes nothing', () => {
    expect(applyTrade(held(2n * UNIT, 80n * CENT), buy(1n * UNIT, 50n * CENT)))
      .toEqual({ netQuantity: 3n * UNIT, totalCost: 130n * CENT, realized: 0n });
    expect(applyTrade(held(0n, 0n), sell(UNIT / 2n, 62_000n * DOLLAR)))
      .toEqual({ netQuantity: -UNIT / 2n, totalCost: 31_000n * DOLLAR, realized: 0n });
  });
});
