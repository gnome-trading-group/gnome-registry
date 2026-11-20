import { validateDefinition } from '../lambda/fees/definition';
import { FeeRegistry, FeeSnapshot, feesKind, heldKeys, keyOf, reconcile, sweep, VenueFees } from '../lambda/sync/metadata/fees';
import { runScheduled } from '../lambda/sync/metadata/kind';
import { VenueFeeSchedule } from '../lambda/sync/venues/fees';
import { kalshiFeeDefinition, kalshiFeeSchedules } from '../lambda/sync/venues/kalshi';
import { polymarketIntlFeeDefinition, polymarketIntlFeeSchedules } from '../lambda/sync/venues/polymarket-intl';
import { memorySnapshots } from './memory-snapshots';

// The Kalshi and Polymarket International cases are the classifier's (gnome-classifier tests/test_fees.py), which
// wrote these schedules before the registry did: the rows must come out the same.

const BEFORE_ACCUMULATOR = new Date('2025-11-15T00:00:00Z');
const AFTER_ACCUMULATOR = new Date('2026-08-07T00:00:00Z');

const takerMaker = (row: { definition: VenueFeeSchedule['definition'] }) =>
  row.definition && [row.definition.components[0].taker, row.definition.components[0].maker];
const at = (iso: string) => new Date(iso).toISOString();

describe('Kalshi fee schedules', () => {
  it('prices each fee type and multiplier', () => {
    const tm = (feeType: string, multiplier: number) => takerMaker({ definition: kalshiFeeDefinition(feeType, multiplier, AFTER_ACCUMULATOR) });
    expect(tm('quadratic', 1)).toEqual([0.07, 0]);
    expect(tm('quadratic_with_maker_fees', 1)).toEqual([0.07, 0.0175]);
    expect(tm('quadratic_with_combo_maker_fees', 1)).toEqual([0.07, 0.035]);
    // Exactly half, not 0.035000000000000004: schedules are compared by value.
    expect(tm('quadratic_with_maker_fees', 0.5)).toEqual([0.035, 0.00875]);
    expect(kalshiFeeDefinition('flat', 1, AFTER_ACCUMULATOR)).toBeNull();
  });

  it('rounds to the cent before the cutover and to $0.0001 across the order after it', () => {
    expect(kalshiFeeDefinition('quadratic', 1, BEFORE_ACCUMULATOR)!.rounding).toEqual({ mode: 'CEIL', increment: 0.01, scope: 'FILL' });
    expect(kalshiFeeDefinition('quadratic', 1, AFTER_ACCUMULATOR)!.rounding).toEqual({ mode: 'CEIL', increment: 0.0001, scope: 'ORDER_ACCUMULATOR' });
  });

  it('gives a series history a row at the rounding cutover', () => {
    const rows = kalshiFeeSchedules([], [
      { id: 'b', series_ticker: 'KXMLBGAME', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 0.5, scheduled_ts: '2026-08-07T04:59:45.131Z' },
      { id: 'a', series_ticker: 'KXMLBGAME', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1, scheduled_ts: '2025-10-04T07:00:00Z' },
    ], []);
    expect(rows.map(r => [r.effectiveFrom, r.sourceRef, takerMaker(r), r.definition!.rounding.scope])).toEqual([
      [at('2025-10-04T07:00:00Z'), 'kalshi:series_fee_change:a', [0.07, 0.0175], 'FILL'],
      [at('2026-03-03T00:00:00Z'), 'kalshi:series_fee_change:a:accumulator', [0.07, 0.0175], 'ORDER_ACCUMULATOR'],
      [at('2026-08-07T04:59:45.131Z'), 'kalshi:series_fee_change:b', [0.035, 0.00875], 'ORDER_ACCUMULATOR'],
    ]);
    expect(rows.every(r => r.feeGroup === 'KXMLBGAME' && r.feeEvent === undefined)).toBe(true);
  });

  it('fills an event override in from its series, and records a lifted one with no definition', () => {
    const series = [{ id: 's', series_ticker: 'KXMLBHIT', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 0.5, scheduled_ts: '2026-08-07T00:00:00Z' }];
    const events = [
      { id: 'e1', event_ticker: 'KXMLBHIT-G', series_ticker: 'KXMLBHIT', fee_type_override: null, fee_multiplier_override: 1, scheduled_ts: '2026-10-16T00:00:00Z' },
      { id: 'e2', event_ticker: 'KXMLBHIT-G', series_ticker: 'KXMLBHIT', fee_type_override: null, fee_multiplier_override: null, scheduled_ts: '2026-10-20T00:00:00Z' },
    ];
    const rows = kalshiFeeSchedules([], series, events).filter(r => r.feeEvent);
    expect(rows.map(r => [r.effectiveFrom, takerMaker(r)])).toEqual([
      [at('2026-10-16T00:00:00Z'), [0.07, 0.0175]],
      [at('2026-10-20T00:00:00Z'), null],
    ]);
    expect(rows.every(r => r.feeEvent === 'KXMLBHIT-G' && r.feeGroup === undefined)).toBe(true);
  });

  it('holds a series charging other than the default, with no history, from July 2025', () => {
    const series = [
      { ticker: 'KXNBA', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 1 },
      { ticker: 'KXMLBGAME', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 0.5 },
      { ticker: 'KXPLAIN', fee_type: 'quadratic', fee_multiplier: 1 },
      { ticker: 'KXBARE' },
    ];
    const changes = [{ id: 'a', series_ticker: 'KXMLBGAME', fee_type: 'quadratic_with_maker_fees', fee_multiplier: 0.5, scheduled_ts: '2026-08-07T00:00:00Z' }];
    expect(kalshiFeeSchedules(series, changes, []).map(r => [r.feeGroup, r.effectiveFrom, r.sourceRef, takerMaker(r)])).toEqual([
      ['KXMLBGAME', at('2026-08-07T00:00:00Z'), 'kalshi:series_fee_change:a', [0.035, 0.00875]],
      ['KXNBA', at('2025-07-01T00:00:00Z'), 'kalshi:series_fee_change:unrecorded-KXNBA', [0.07, 0.0175]],
      ['KXNBA', at('2026-03-03T00:00:00Z'), 'kalshi:series_fee_change:unrecorded-KXNBA:accumulator', [0.07, 0.0175]],
    ]);
  });

  it('records fee types no schedule expresses without a definition, flagged by their source_ref', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const changes = [{ id: 'a', series_ticker: 'KXFLAT', fee_type: 'flat', fee_multiplier: 1, scheduled_ts: '2026-08-07T00:00:00Z' }];
    const events = [{ id: 'e', event_ticker: 'KXFLAT-G', series_ticker: 'KXFLAT', fee_type_override: 'flat', fee_multiplier_override: 1, scheduled_ts: '2026-10-18T00:00:00Z' }];
    expect(kalshiFeeSchedules([], changes, events).map(r => [r.feeGroup ?? r.feeEvent, r.definition, r.sourceRef])).toEqual([
      ['KXFLAT', null, 'kalshi:series_fee_change:a:unsupported:flat'],
      ['KXFLAT-G', null, 'kalshi:event_fee_change:e:unsupported:flat'],
    ]);
  });

  it('writes only definitions the registry accepts', () => {
    for (const feeType of ['quadratic', 'quadratic_with_maker_fees', 'quadratic_with_combo_maker_fees']) {
      for (const when of [BEFORE_ACCUMULATOR, AFTER_ACCUMULATOR]) {
        const definition = kalshiFeeDefinition(feeType, 0.5, when)!;
        expect(validateDefinition(definition)).toEqual(definition);
      }
    }
  });
});

const intl = (rate: number, exponent = 1, rebate?: number) => polymarketIntlFeeDefinition({
  feesEnabled: true, feeSchedule: { exponent, rate, takerOnly: true, ...(rebate !== undefined ? { rebateRate: rebate } : {}) },
})!;

describe('Polymarket International fee schedules', () => {
  beforeEach(() => { jest.spyOn(console, 'warn').mockImplementation(() => undefined); });

  it("reads a market's own schedule", () => {
    const market = { feesEnabled: true, feeSchedule: { exponent: 1, rate: 0.05, takerOnly: true, rebateRate: 0.15 } };
    expect(polymarketIntlFeeDefinition(market)).toEqual({
      currency: 'USD',
      components: [{ kind: 'PRICE_CURVE', taker: 0.05, maker: 0, exponent: 1 }],
      rounding: { mode: 'HALF_UP', increment: 0.00001, scope: 'FILL' },
      makerRebate: { share: 0.15 },
    });
    expect(polymarketIntlFeeDefinition({ ...market, feeSchedule: { ...market.feeSchedule, rebateRate: 0 } })).not.toHaveProperty('makerRebate');
    expect(polymarketIntlFeeDefinition({ ...market, feesEnabled: false })).toBeNull();
    expect(polymarketIntlFeeDefinition({ feesEnabled: false })).toBeNull();
    expect(validateDefinition(polymarketIntlFeeDefinition(market))).toBeTruthy();
  });

  it('gives a type that charges nothing a zero schedule, so every market keyed to a type has one', () => {
    expect(takerMaker({ definition: polymarketIntlFeeDefinition({ feesEnabled: true, feeSchedule: { rate: 0, exponent: 1 } }) })).toEqual([0, 0]);
  });

  it('adds a schedule for a maker rebate and keeps the rollout one', () => {
    const now = new Date('2026-11-12T12:00:00Z');
    const plain = polymarketIntlFeeSchedules(new Map([['politics_fees', intl(0.04)]]), now);
    const rows = polymarketIntlFeeSchedules(new Map([
      ['politics_fees', intl(0.04, 1, 0.25)],
      ['sports_fees_v3', intl(0.05, 1, 0.15)],
      ['economics_fees', intl(0.06, 1, 0.25)],
    ]), now);
    expect(rows.map(r => [r.feeGroup, r.effectiveFrom, r.definition!.makerRebate])).toEqual([
      ['politics_fees', at('2026-03-30T00:00:00Z'), undefined],
      ['politics_fees', at('2026-11-12T12:00:00Z'), { share: 0.25 }],
      ['sports_fees_v3', at('2026-07-11T00:00:00Z'), undefined],
      ['sports_fees_v3', at('2026-07-11T00:00:00Z'), { share: 0.15 }],
      // Rates no rollout lists: one schedule, rebate included, from now.
      ['economics_fees', at('2026-11-12T12:00:00Z'), { share: 0.25 }],
    ]);
    // The rollout schedule is the one already recorded, so it is known and not written again.
    expect(keyOf(rows[0], 'definition')).toBe(keyOf(plain[0], 'definition'));
    expect(keyOf(rows[1], 'definition')).not.toBe(keyOf(plain[0], 'definition'));
  });

  it("dates a rebate at a share the docs don't date from now", () => {
    const now = new Date('2026-11-12T12:00:00Z');
    expect(polymarketIntlFeeSchedules(new Map([['sports_fees_v3', intl(0.05, 1, 0.2)]]), now)[1].effectiveFrom).toBe(now.toISOString());
  });

  it('holds a type from its rollout unless its rates moved', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    const rows = polymarketIntlFeeSchedules(new Map([
      ['crypto_15_min', intl(0.25, 2)], ['politics_fees', intl(0.04)], ['economics_fees', intl(0.06)], ['new_fees', intl(0.05)],
    ]), now);
    expect(rows.map(r => [r.feeGroup, r.effectiveFrom])).toEqual([
      ['crypto_15_min', at('2026-01-05T00:00:00Z')],
      ['politics_fees', at('2026-03-30T00:00:00Z')],
      ['economics_fees', now.toISOString()],
      ['new_fees', now.toISOString()],
    ]);
    expect(rows.every(r => r.sourceRef.startsWith(`polymarket_intl:fee_type:${r.feeGroup}:`))).toBe(true);
    const moved = polymarketIntlFeeSchedules(new Map([['politics_fees', intl(0.05)]]), now);
    expect(keyOf(moved[0], 'definition')).not.toBe(keyOf(rows[1], 'definition'));
  });

  it('knows a row the classifier wrote by its definition and date, whatever its digest', () => {
    const written = {
      feeGroup: 'politics_fees', effectiveFrom: '2026-03-30T00:00:00.000Z', definition: JSON.parse(JSON.stringify(intl(0.04))),
      sourceRef: 'polymarket_intl:fee_type:politics_fees:ab1809a47525',
    };
    const computed = polymarketIntlFeeSchedules(new Map([['politics_fees', intl(0.04)]]), new Date('2026-11-20T12:00:00Z'))[0];
    expect(heldKeys(written, 'definition')).toContain(keyOf(computed, 'definition'));
    // A row dated when first seen is known by its definition alone, whenever it is read again.
    const seen = polymarketIntlFeeSchedules(new Map([['politics_fees', intl(0.04, 1, 0.25)]]), new Date('2026-11-20T12:00:00Z'))[1];
    expect(heldKeys({ ...written, effectiveFrom: '2026-11-14T17:33:35.619Z', definition: intl(0.04, 1, 0.25) }, 'definition'))
      .toContain(keyOf(seen, 'definition'));
  });

  describe('after the November 2026 change', () => {
    const change = '2026-11-20T23:59:00.000Z';
    const after = new Date('2026-11-21T02:00:00Z');

    it('dates the announced coefficients from the change, with no market rebate', () => {
      const rows = polymarketIntlFeeSchedules(new Map([
        ['crypto_fees_v2', intl(0.01, 1, 0.2)], ['politics_elections_fees', intl(0.05)], ['zero_fees', intl(0)],
      ]), after);
      expect(rows.map(r => [r.feeGroup, r.effectiveFrom, takerMaker(r), r.definition!.makerRebate, r.dated])).toEqual([
        ['crypto_fees_v2', change, [0.01, 0], undefined, true],
        ['politics_elections_fees', change, [0.05, 0], undefined, true],
        ['zero_fees', change, [0, 0], undefined, true],
      ]);
    });

    it('ends the market rebate of a type whose rate held, as a new row from the change', () => {
      const [sports] = polymarketIntlFeeSchedules(new Map([['sports_fees_v3', intl(0.05, 1, 0.15)]]), after);
      expect([sports.effectiveFrom, sports.definition!.makerRebate]).toEqual([change, undefined]);
      const rollout = { feeGroup: 'sports_fees_v3', effectiveFrom: '2026-07-11T00:00:00.000Z', definition: intl(0.05), sourceRef: 'x' };
      expect(heldKeys(rollout, 'definition')).not.toContain(keyOf(sports, 'definition'));
    });

    it('ends the rebate from the change for a type still at its old rate', () => {
      const [crypto] = polymarketIntlFeeSchedules(new Map([['crypto_fees_v2', intl(0.07, 1, 0.2)]]), after);
      expect([crypto.effectiveFrom, takerMaker(crypto), crypto.definition!.makerRebate]).toEqual([change, [0.07, 0], undefined]);
    });

    it("dates a rate no entry lists from the change while Gamma moves over, and from when first seen after", () => {
      const read = (at: Date) => polymarketIntlFeeSchedules(new Map([['politics_elections_fees', intl(0.04, 1, 0.25)]]), at)[0];
      expect([read(after).effectiveFrom, read(after).definition!.makerRebate, read(after).dated]).toEqual([change, undefined, true]);
      const later = new Date('2026-12-10T00:00:00Z');
      expect([read(later).effectiveFrom, read(later).dated]).toEqual([later.toISOString(), false]);
    });

    it('dates a coefficient Gamma shows before the change from the change, without its old rebate', () => {
      const before = new Date('2026-11-20T23:00:00Z');
      expect(polymarketIntlFeeSchedules(new Map([['crypto_fees_v2', intl(0.01, 1, 0.2)]]), before).map(r => [r.effectiveFrom, r.definition!.makerRebate]))
        .toEqual([[change, undefined]]);
    });

    it('still gives the rollout rows before the change', () => {
      const before = new Date('2026-11-20T23:00:00Z');
      expect(polymarketIntlFeeSchedules(new Map([['crypto_fees_v2', intl(0.07, 1, 0.2)]]), before).map(r => r.effectiveFrom))
        .toEqual(['2026-03-30T00:00:00.000Z', before.toISOString()]);
    });
  });
});

const row = (sourceRef: string, feeGroup = 'G', taker = 0.07): VenueFeeSchedule => ({
  feeGroup, effectiveFrom: '2026-01-01T00:00:00.000Z', sourceRef,
  definition: { currency: 'USD', components: [{ kind: 'PRICE_CURVE', taker, maker: 0, exponent: 1 }], rounding: { mode: 'NONE' } },
});

function fakeRegistry(held: VenueFeeSchedule[] = []) {
  const posted: VenueFeeSchedule[] = [];
  const calls: string[] = [];
  const registry: FeeRegistry = {
    exchangeId: async () => { calls.push('exchangeId'); return 7; },
    held: async () => { calls.push('held'); return [...held, ...posted]; },
    post: async (_id, rows) => { calls.push(`post ${rows.length}`); posted.push(...rows); return rows.length; },
  };
  return { registry, posted, calls };
}

const venueOf = (rows: VenueFeeSchedule[], knownBy: VenueFees['knownBy'] = 'sourceRef', unreadable: string[] = []): VenueFees =>
  ({ read: async () => ({ schedules: rows, unreadable }), knownBy });
const now = new Date('2026-11-20T12:00:00Z');

describe('the fees kind', () => {
  it('reconciles by writing only the rows the registry lacks, and rebuilds the snapshot from its rows', async () => {
    const { snapshots, held } = memorySnapshots<FeeSnapshot>();
    const { registry, posted } = fakeRegistry([row('a'), row('lifted')]);
    const counts = await reconcile('KALSHI', venueOf([row('a'), row('b')]), now, registry, snapshots);
    expect(posted.map(r => r.sourceRef)).toEqual(['b']);
    expect(counts).toMatchObject({ Read: 2, Held: 2, Written: 1, Known: 1, NotRead: 1 });
    expect(held('KALSHI')!.known.sort()).toEqual(['a', 'b', 'lifted']);
  });

  it('sweeps without reading the registry, posting only rows the snapshot lacks', async () => {
    const { snapshots, held } = memorySnapshots<FeeSnapshot>({ KALSHI: { known: ['a'] } });
    const { registry, posted, calls } = fakeRegistry();
    expect(await sweep('KALSHI', venueOf([row('a'), row('b')]), now, registry, snapshots)).toMatchObject({ Read: 2, Written: 1, Known: 1 });
    expect(posted.map(r => r.sourceRef)).toEqual(['b']);
    expect(calls).not.toContain('held');
    expect(held('KALSHI')!.known.sort()).toEqual(['a', 'b']);
    await sweep('KALSHI', venueOf([row('a'), row('b')]), now, registry, snapshots);
    expect(posted).toHaveLength(1);
  });

  it('makes no registry call at all from a sweep with nothing new', async () => {
    const { snapshots } = memorySnapshots<FeeSnapshot>({ KALSHI: { known: ['a'] } });
    const { registry, calls } = fakeRegistry();
    await sweep('KALSHI', venueOf([row('a')]), now, registry, snapshots);
    expect(calls).toEqual([]);
  });

  it('knows a Polymarket International row by its target and definition, whatever its source_ref or date', async () => {
    const { snapshots } = memorySnapshots<FeeSnapshot>();
    const { registry, posted } = fakeRegistry([{ ...row('polymarket_intl:fee_type:G:python', 'G'), effectiveFrom: '2026-11-14T00:00:00.000Z' }]);
    await reconcile('POLYMARKET_INTL', venueOf([row('polymarket_intl:fee_type:G:ts', 'G'), row('x', 'G', 0.05)], 'definition'), now, registry, snapshots);
    expect(posted.map(r => r.definition!.components[0].taker)).toEqual([0.05]);
  });

  it('lets a sweep with no snapshot reconcile to make one, and reports it unhealthy', async () => {
    const lines: string[] = [];
    jest.spyOn(console, 'log').mockImplementation((line: unknown) => { lines.push(String(line)); });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { snapshots, held } = memorySnapshots<FeeSnapshot>();
    const { registry, calls } = fakeRegistry([row('a')]);
    await runScheduled(feesKind(registry, { KALSHI: venueOf([row('a')]) }), { mode: 'sweep', venue: 'KALSHI' }, { now, snapshots });
    expect(calls).toContain('held');
    expect(held('KALSHI')!.known).toEqual(['a']);
    const metrics = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).find(m => m?._aws);
    expect(metrics).toMatchObject({ Kind: 'fees', Mode: 'sweep', Venue: 'KALSHI', Ok: 0, NoSnapshot: 1, Written: 0 });
  });

  it('fails the run when the registry refuses a write', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { snapshots, held } = memorySnapshots<FeeSnapshot>({ KALSHI: { known: [] } });
    const registry: FeeRegistry = { exchangeId: async () => 7, held: async () => [], post: async () => { throw new Error('400'); } };
    await expect(runScheduled(feesKind(registry, { KALSHI: venueOf([row('a')]) }), { mode: 'sweep', venue: 'KALSHI' }, { now, snapshots }))
      .rejects.toThrow('KALSHI');
    expect(held('KALSHI')!.known).toEqual([]);
  });

  it('counts the fee types whose schedule the venue read could not give', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { snapshots } = memorySnapshots<FeeSnapshot>({ POLYMARKET_INTL: { known: [] } });
    expect(await sweep('POLYMARKET_INTL', venueOf([], 'definition', ['odd_fees']), now, fakeRegistry().registry, snapshots))
      .toMatchObject({ Read: 0, Unreadable: 1 });
  });

  it('posts at most one row per key, even when the venue reads one twice', async () => {
    const { snapshots } = memorySnapshots<FeeSnapshot>({ KALSHI: { known: [] } });
    const { registry, posted } = fakeRegistry();
    await sweep('KALSHI', venueOf([row('a'), row('a')]), now, registry, snapshots);
    expect(posted).toHaveLength(1);
  });
});
