import { addFill, emptyAccumulator, finish, sumVolumes, volumeBetween } from '../lambda/endpoints/pnl-volume';

const CENT = 10_000_000n;
const UNIT = 1_000_000n;

function fill(at: number, qty: bigint, priceCents: bigint, liquidity: string | null, source = 'VENUE') {
  return {
    source, recorded_at: new Date(at), fill_qty: String(qty * UNIT), fill_price: String(priceCents * CENT),
    fee: String(CENT), liquidity,
  };
}

describe('trading volume', () => {
  it('counts the money each venue fill traded, split by maker and taker, with fills and fees', () => {
    const acc = emptyAccumulator();
    addFill(acc, fill(0, 10n, 40n, 'MAKER'));
    addFill(acc, fill(0, 4n, 54n, 'TAKER'));
    addFill(acc, fill(0, 1n, 30n, null, 'RECOVERY'));
    expect(finish(acc)).toEqual({
      notional: 646n * CENT, maker: 400n * CENT, taker: 216n * CENT, fills: 3, fees: 3n * CENT,
    });
  });

  it('leaves out what moves a position without trading', () => {
    const acc = emptyAccumulator();
    for (const source of ['SETTLEMENT', 'MANUAL', 'ADJUSTMENT', 'RESET', 'GAP']) addFill(acc, fill(0, 10n, 100n, null, source));
    expect(finish(acc)).toEqual({ notional: 0n, maker: 0n, taker: 0n, fills: 0, fees: 0n });
  });

  it('sums fractional quantities before scaling, so a total does not depend on how fills were split', () => {
    const acc = emptyAccumulator();
    // A third of a contract at 1c, three times, is exactly 1c.
    for (let i = 0; i < 3; i++) addFill(acc, { ...fill(0, 0n, 1n, 'MAKER'), fill_qty: String(UNIT / 3n + (i === 0 ? 1n : 0n)) });
    expect(finish(acc).notional).toBe(CENT);
  });

  it('puts each fill between the points around it, whatever order the fills come in', () => {
    const times = [100, 200, 300];
    const volumes = volumeBetween([
      fill(250, 1n, 10n, 'MAKER'),
      fill(100, 1n, 99n, 'MAKER'),
      fill(150, 2n, 10n, 'TAKER'),
      fill(200, 1n, 10n, 'TAKER'),
      fill(301, 1n, 99n, 'MAKER'),
    ], times);
    expect(volumes.map(v => [v.notional, v.fills])).toEqual([[0n, 0], [30n * CENT, 2], [10n * CENT, 1]]);
  });

  it('adds volumes field by field', () => {
    const one = { notional: 5n, maker: 3n, taker: 2n, fills: 1, fees: 1n };
    expect(sumVolumes([one, one])).toEqual({ notional: 10n, maker: 6n, taker: 4n, fills: 2, fees: 2n });
    expect(sumVolumes([])).toEqual({ notional: 0n, maker: 0n, taker: 0n, fills: 0, fees: 0n });
  });
});
