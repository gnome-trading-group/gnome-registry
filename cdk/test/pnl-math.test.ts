import { fillImpact, MAX_POINTS, pickResolution, pointTimes, sessionPnl } from '../lambda/endpoints/pnl-math';

const SECOND = 1000;
const HOUR = 3600 * SECOND;

describe('chart resolution', () => {
  it('uses the smallest step that keeps a window within the point limit', () => {
    expect(pickResolution(10 * 60 * SECOND)).toBe(SECOND);
    expect(pickResolution(HOUR)).toBe(5 * SECOND);
    expect(pickResolution(30 * 24 * HOUR)).toBe(HOUR);
  });

  it('honours a requested step only when it fits', () => {
    expect(pickResolution(HOUR, 60 * SECOND)).toBe(60 * SECOND);
    expect(pickResolution(24 * HOUR, SECOND)).toBe(60 * SECOND);
  });

  it('places points at the window edges and on epoch-aligned steps between them', () => {
    expect(pointTimes(2500, 7000, 2000)).toEqual([2500, 4000, 6000, 7000]);
    expect(pointTimes(4000, 4000, 2000)).toEqual([4000]);
    expect(pointTimes(0, 10 * HOUR, pickResolution(10 * HOUR)).length).toBeLessThanOrEqual(MAX_POINTS + 2);
  });
});

describe('session PnL', () => {
  const position = (net: bigint, cost: bigint, realized = 0n, fees = 0n) =>
    ({ netQuantity: net, totalCost: cost, realizedPnl: realized, totalFees: fees });
  const mark = (mid: bigint) => ({ bid: mid, ask: mid, lastTrade: 0n });

  it('flags inherited inventory that had no mark when the session started', () => {
    const p = sessionPnl({
      opening: position(10n, 400n), openingMark: null, current: position(10n, 400n), mark: mark(50n),
    });
    expect([p.openingMarkMissing, p.carry]).toEqual([true, 0n]);
  });
});

describe('impact of a fill outside any session', () => {
  const CENT = 10_000_000n;
  const UNIT = 1_000_000n;
  const position = (units: bigint, costCents: bigint) =>
    ({ netQuantity: units * UNIT, totalCost: costCents * CENT, realizedPnl: 0n, totalFees: 0n });
  const FLAT = position(0n, 0n);
  const mark = (midCents: bigint) => ({ bid: midCents * CENT, ask: midCents * CENT, lastTrade: 0n });
  // 10 bought at 40c, last marked at 45c: unrealized 50c.
  const held = position(10n, 400n);

  it('is what a settlement realizes beyond the mark it closed against', () => {
    expect(fillImpact(held, FLAT, 600n * CENT, 0n, mark(45n))).toBe(550n * CENT);
    expect(fillImpact(held, FLAT, -400n * CENT, 0n, mark(45n))).toBe(-450n * CENT);
  });

  it('is only the fee and the distance from the mark for a partial close by hand', () => {
    // Sells 4 at 44c: realizes 16c, 1c under the mark on 4, keeps 6 at 40c.
    expect(fillImpact(held, position(6n, 240n), 16n * CENT, CENT, mark(45n))).toBe(-5n * CENT);
  });

  it('writes off the unrealized PnL a reset or a correction removes', () => {
    expect(fillImpact(held, FLAT, 0n, 0n, mark(45n))).toBe(-50n * CENT);
    expect(fillImpact(held, position(10n, 450n), 0n, 0n, mark(45n))).toBe(-50n * CENT);
  });

  it('values inventory at its entry when nothing marked it, as the OMS does', () => {
    expect(fillImpact(held, FLAT, 600n * CENT, 0n, null)).toBe(600n * CENT);
  });
});
