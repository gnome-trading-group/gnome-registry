import { MAX_POINTS, pickResolution, pointTimes, sessionPnl } from '../lambda/endpoints/pnl-math';

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
