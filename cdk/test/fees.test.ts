import { FeeScope, IFeeDefinition, IScheduleRow, resolveTimeline, validateDefinition } from '../lambda/endpoints/fees';
import { ValidationError } from '../lambda/endpoints/base';

const curve = (taker: number, maker = 0): IFeeDefinition => ({
  currency: 'USD',
  components: [{ kind: 'PRICE_CURVE', taker, maker, exponent: 1 }],
  rounding: { mode: 'HALF_EVEN', increment: 0.01, scope: 'FILL' },
});

let nextId = 1;
function row(scope: FeeScope, effective: string, definition: IFeeDefinition | null, recorded = '2026-10-15T00:00:00Z'): IScheduleRow {
  return {
    fee_schedule_id: String(nextId++), scope, effective_from: new Date(effective), recorded_at: new Date(recorded), definition,
  };
}

const taker = (d: IFeeDefinition) => d.components[0].taker;

describe('validateDefinition', () => {
  it('accepts each venue shape we store', () => {
    expect(() => validateDefinition(curve(0.0695, -0.0125))).not.toThrow();
    expect(() => validateDefinition({
      currency: 'USD', components: [{ kind: 'PRICE_CURVE', taker: 0.07, maker: 0.0175 }],
      rounding: { mode: 'CEIL', increment: 0.0001, scope: 'ORDER_ACCUMULATOR' },
    })).not.toThrow();
    expect(() => validateDefinition({
      currency: 'USD', components: [{ kind: 'NOTIONAL', taker: 0.00045, maker: 0.00015 }], rounding: { mode: 'NONE' },
    })).not.toThrow();
    expect(() => validateDefinition({
      currency: 'USD', components: [{ kind: 'PER_UNIT', taker: 0.01, maker: 0.01, side: 'SELL' }], rounding: { mode: 'NONE' },
    })).not.toThrow();
  });

  it.each([
    ['an unknown kind', { ...curve(0.07), components: [{ kind: 'TIERED', taker: 0.07, maker: 0 }] }],
    ['no components', { ...curve(0.07), components: [] }],
    ['a rate that is not a number', { ...curve(0.07), components: [{ kind: 'NOTIONAL', taker: '0.07', maker: 0 }] }],
    ['an exponent outside a curve', { ...curve(0.07), components: [{ kind: 'NOTIONAL', taker: 0.07, maker: 0, exponent: 2 }] }],
    ['an unknown field', { ...curve(0.07), components: [{ kind: 'NOTIONAL', taker: 0.07, maker: 0, tier: 'VIP1' }] }],
    ['rounding without an increment', { ...curve(0.07), rounding: { mode: 'CEIL', scope: 'FILL' } }],
    ['an accumulator that does not round up', { ...curve(0.07), rounding: { mode: 'HALF_UP', increment: 0.01, scope: 'ORDER_ACCUMULATOR' } }],
    ['an increment with no rounding', { ...curve(0.07), rounding: { mode: 'NONE', increment: 0.01 } }],
    ['a lower-case currency', { ...curve(0.07), currency: 'usd' }],
  ])('rejects %s', (_name, definition) => {
    expect(() => validateDefinition(definition)).toThrow(ValidationError);
  });
});

describe('resolveTimeline', () => {
  it('takes the most specific scope in force, falling back as overrides start and are lifted', () => {
    const timeline = resolveTimeline([
      row('EXCHANGE', '2025-01-01T00:00:00Z', curve(0.07)),
      row('FEE_GROUP', '2026-08-07T00:00:00Z', curve(0.035)),
      row('FEE_EVENT', '2026-10-10T00:00:00Z', curve(0.07)),
      row('FEE_EVENT', '2026-10-18T00:00:00Z', null),
    ]);
    expect(timeline.map((e) => [e.effectiveFrom, e.effectiveTo, e.scope, taker(e.definition)])).toEqual([
      ['2025-01-01T00:00:00.000Z', '2026-08-07T00:00:00.000Z', 'EXCHANGE', 0.07],
      ['2026-08-07T00:00:00.000Z', '2026-10-10T00:00:00.000Z', 'FEE_GROUP', 0.035],
      ['2026-10-10T00:00:00.000Z', '2026-10-18T00:00:00.000Z', 'FEE_EVENT', 0.07],
      ['2026-10-18T00:00:00.000Z', null, 'FEE_GROUP', 0.035],
    ]);
  });

  it('lets a correction replace the row it fixes for all time, and leaves later changes alone', () => {
    const timeline = resolveTimeline([
      row('EXCHANGE', '2026-04-03T04:00:00Z', curve(0.5), '2026-10-01T00:00:00Z'),
      row('EXCHANGE', '2026-07-01T04:00:00Z', curve(0.06), '2026-10-01T00:00:00Z'),
      row('EXCHANGE', '2026-04-03T04:00:00Z', curve(0.05), '2026-10-02T00:00:00Z'),
    ]);
    expect(timeline.map((e) => taker(e.definition))).toEqual([0.05, 0.06]);
  });

  it('leaves times before the first schedule uncovered', () => {
    const timeline = resolveTimeline([row('LISTING', '2026-01-05T00:00:00Z', curve(0.07))]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].effectiveFrom).toBe('2026-01-05T00:00:00.000Z');
  });

  it('merges change points that leave the same schedule in force', () => {
    const exchange = row('EXCHANGE', '2025-01-01T00:00:00Z', curve(0.07));
    const timeline = resolveTimeline([exchange, row('FEE_EVENT', '2026-10-18T00:00:00Z', null)]);
    expect(timeline).toEqual([expect.objectContaining({ feeScheduleId: exchange.fee_schedule_id, effectiveTo: null })]);
  });

  it('trims to the entries in force at some point in [from, to]', () => {
    const rows = [
      row('EXCHANGE', '2026-04-03T00:00:00Z', curve(0.05)),
      row('EXCHANGE', '2026-07-01T00:00:00Z', curve(0.06)),
      row('EXCHANGE', '2026-09-17T00:00:00Z', curve(0.0695)),
    ];
    const between = resolveTimeline(rows, new Date('2026-05-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    expect(between.map((e) => taker(e.definition))).toEqual([0.05, 0.06]);
    const atBoundary = resolveTimeline(rows, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));
    expect(atBoundary.map((e) => taker(e.definition))).toEqual([0.06]);
  });
});
