import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { ValidationError } from '../lambda/endpoints/base';
import { FeeScheduleHandler } from '../lambda/endpoints/fees';
import { validateDefinition } from '../lambda/fees/definition';
import { ListingSpecHandler } from '../lambda/endpoints/listing-specs';
import { ListingHandler } from '../lambda/endpoints/listings';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

const MIGRATION = join(__dirname, '..', 'lambda', 'db-init', 'migrations', '043_fee_schedule.sql');

// The data statements of migration 043 (its fee group backfill and seeds), rerun on this test's own rows.
function seedStatements(): string[] {
  const sql = readFileSync(MIGRATION, 'utf8');
  const groups = sql.indexOf('UPDATE sm.listing l SET fee_group');
  const seeds = sql.indexOf('INSERT INTO sm.fee_schedule');
  // The seed rows' comments contain semicolons, so the seed statement ends after its VALUES list.
  return [
    sql.slice(groups, sql.indexOf(';', groups) + 1),
    sql.slice(seeds, sql.indexOf(';', sql.indexOf(') AS s (', seeds)) + 1),
  ];
}

// Kalshi (1) lists two markets of one venue event (KXMLBHIT-G) in series KXMLBHIT: 500/501 (YES/NO of one market) and
// 502 (the other market's YES), which the classifier keeps as separate sm.events. Polymarket US (2), Hyperliquid (3)
// and Lighter (4) carry the schedules migration 043 seeds.
describeDb('Fee schedules and point-in-time listing specs, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  let fees: FeeScheduleHandler;
  let specs: ListingSpecHandler;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE sm.fee_schedule, sm.listing_spec, sm.listing, sm.security, sm.exchange
      RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code) VALUES
      (1, 'K', 'us-east-1', 'KALSHI'), (2, 'P', 'us-east-1', 'POLYMARKET_US'),
      (3, 'H', 'ap-northeast-1', 'HYPERLIQUID'), (4, 'L', 'ap-northeast-1', 'LIGHTER')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'KX-YES', 4), (2, 'KX-NO', 4),
      (7, 'KX2-YES', 4), (3, 'PM-LONG', 4), (4, 'TT-LONG', 4), (5, 'BTC', 1), (6, 'HYPE/USDC', 0)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id,
      exchange_security_symbol, fee_group, fee_event) VALUES
      (500, 1, 1, 'G-1:yes', 'G-1-YES', 'KXMLBHIT', 'KXMLBHIT-G'), (501, 1, 2, 'G-1:no', 'G-1-NO', 'KXMLBHIT', 'KXMLBHIT-G'),
      (502, 1, 7, 'G-2:yes', 'G-2-YES', 'KXMLBHIT', 'KXMLBHIT-G'),
      (600, 2, 3, 'nfl:long', 'NFL', NULL, NULL), (601, 2, 4, 'tt:long', 'TT', 'table-tennis', NULL),
      (700, 3, 5, 'BTC', 'BTC', NULL, NULL), (701, 3, 6, 'HYPE/USDC', 'HYPE/USDC', NULL, NULL)`);
    fees = new FeeScheduleHandler();
    fees.client = client;
    specs = new ListingSpecHandler();
    specs.client = client;
  });

  const curve = (taker: number, maker = 0) => ({
    currency: 'USD', components: [{ kind: 'PRICE_CURVE', taker, maker, exponent: 1 }],
    rounding: { mode: 'CEIL', increment: 0.0001, scope: 'ORDER_ACCUMULATOR' },
  });

  async function timeline(listingIds: number[], query: Record<string, string> = {}) {
    const response = await fees.get({ listingIds: listingIds.join(','), ...query });
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body) as { listingId: number; timeline: any[] }[];
  }

  describe('listing specs', () => {
    const spec = (extra: Record<string, unknown> = {}) => JSON.stringify({ listingId: 500, tickSize: 10, lotSize: 1, ...extra });
    const effective = async () => (await client.query(
      `SELECT tick_size::int AS tick, effective_from FROM sm.listing_spec ORDER BY id`)).rows;

    it('dates a first spec from the epoch and later ones from now, unless told otherwise', async () => {
      await specs.createOne(spec());
      await specs.createOne(spec({ tickSize: 20 }));
      await specs.createOne(spec({ tickSize: 30, effectiveFrom: '2026-01-01T00:00:00Z' }));
      const rows = await effective();
      expect(rows[0].effective_from.toISOString()).toBe('1970-01-01T00:00:00.000Z');
      expect(Date.now() - rows[1].effective_from.getTime()).toBeLessThan(60_000);
      expect(rows[2].effective_from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('a direct insert without effective_from (the classifier) is dated by the same rule', async () => {
      await client.query(`INSERT INTO sm.listing_spec (listing_id, tick_size, lot_size) VALUES (500, 10, 1), (501, 10, 1)`);
      const rows = await effective();
      expect(rows.map((r: any) => r.effective_from.toISOString())).toEqual(['1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z']);
    });

    it('a correction replaces the spec in force for all time; a venue change only from when it happened', async () => {
      await specs.createOne(spec({ tickSize: 1 }));
      await specs.createOne(spec({ tickSize: 10, correction: true }));
      await specs.createOne(spec({ tickSize: 100, effectiveFrom: '2026-07-01T00:00:00Z' }));
      const at = async (time: string) => JSON.parse((await specs.get({ listingId: '500', at: time })).body)[0].tick_size;
      expect(await at('2025-01-01T00:00:00Z')).toBe('10');
      expect(await at('2026-06-30T23:59:59Z')).toBe('10');
      expect(await at('2026-07-01T00:00:00Z')).toBe('100');
      expect(JSON.parse((await specs.get({ listingId: '500' })).body)[0].tick_size).toBe('100');

      const range = JSON.parse((await specs.get({ listingId: '500', from: '2026-01-01T00:00:00Z', to: '2026-12-31T00:00:00Z' })).body);
      expect(range.map((r: any) => r.tick_size)).toEqual(['10', '100']);
      const before = JSON.parse((await specs.get({ listingId: '500', from: '2025-01-01T00:00:00Z', to: '2025-12-31T00:00:00Z' })).body);
      expect(before.map((r: any) => r.tick_size)).toEqual(['10']);
    });

    it('refuses effectiveFrom together with correction', async () => {
      await expect(specs.createOne(spec({ effectiveFrom: '2026-01-01T00:00:00Z', correction: true })))
        .rejects.toThrow(ValidationError);
    });
  });

  it('listings carry fee keys, and a present null clears one', async () => {
    const listings = new ListingHandler();
    listings.client = client;
    const created = JSON.parse((await listings.createOne(JSON.stringify({
      exchangeId: 1, securityId: 2, exchangeSecurityId: "O'B:yes", exchangeSecuritySymbol: 'OB', feeGroup: 'KXMLBHIT', feeEvent: "KXMLBHIT-O'B",
    }))).body);
    expect([created.fee_group, created.fee_event]).toEqual(['KXMLBHIT', "KXMLBHIT-O'B"]);
    await listings.modifyMany(JSON.stringify([{ listingId: created.listing_id, feeEvent: null }]));
    const after = (await client.query(`SELECT fee_group, fee_event FROM sm.listing WHERE listing_id = $1`, [created.listing_id])).rows[0];
    expect(after).toEqual({ fee_group: 'KXMLBHIT', fee_event: null });
  });

  describe('fee schedules', () => {
    it('resolves every market of a venue event through its fee event, fee group and exchange', async () => {
      const post = (body: Record<string, unknown>) => fees.createOne(JSON.stringify({ source: 'VENUE_API', ...body }));
      expect((await post({ exchangeId: 1, effectiveFrom: '2025-01-01T00:00:00Z', definition: curve(0.07) })).statusCode).toBe(200);
      await post({ exchangeId: 1, feeGroup: 'KXMLBHIT', effectiveFrom: '2026-08-07T04:59:45Z', definition: curve(0.035, 0.00875) });
      await post({ exchangeId: 1, feeEvent: 'KXMLBHIT-G', effectiveFrom: '2026-10-10T00:00:00Z', definition: curve(0.07, 0.0175) });
      await post({ exchangeId: 1, feeEvent: 'KXMLBHIT-G', effectiveFrom: '2026-10-18T00:00:00Z', definition: null });

      const [yes, no, other] = await timeline([500, 501, 502]);
      expect(yes.timeline).toEqual(no.timeline);
      expect(other.timeline).toEqual(yes.timeline);
      expect(yes.timeline.map((e) => [e.effectiveFrom, e.scope, e.definition.components[0].taker])).toEqual([
        ['2025-01-01T00:00:00.000Z', 'EXCHANGE', 0.07],
        ['2026-08-07T04:59:45.000Z', 'FEE_GROUP', 0.035],
        ['2026-10-10T00:00:00.000Z', 'FEE_EVENT', 0.07],
        ['2026-10-18T00:00:00.000Z', 'FEE_GROUP', 0.035],
      ]);
    });

    it('answers as it was known at a time', async () => {
      await client.query(`INSERT INTO sm.fee_schedule (exchange_id, effective_from, recorded_at, definition, source) VALUES
        (1, '2025-01-01', '2026-01-01', $1, 'MANUAL'), (1, '2025-01-01', '2026-06-01', $2, 'MANUAL')`,
        [JSON.stringify(curve(0.1)), JSON.stringify(curve(0.07))]);
      const [now] = await timeline([500]);
      expect(now.timeline[0].definition.components[0].taker).toBe(0.07);
      const [then] = await timeline([500], { knownAsOf: '2026-03-01T00:00:00Z' });
      expect(then.timeline[0].definition.components[0].taker).toBe(0.1);
    });

    it('refuses a row naming two targets, a bad definition, or any change to a stored row', async () => {
      const base = { source: 'MANUAL', effectiveFrom: '2026-01-01T00:00:00Z', definition: curve(0.07) };
      await expect(fees.createOne(JSON.stringify({ ...base, exchangeId: 1, listingId: 500 }))).rejects.toThrow(ValidationError);
      await expect(fees.createOne(JSON.stringify({ ...base, feeGroup: 'X', listingId: 500 }))).rejects.toThrow(ValidationError);
      await expect(fees.createOne(JSON.stringify({ ...base, exchangeId: 1, feeGroup: 'X', feeEvent: 'Y' })))
        .rejects.toThrow(ValidationError);
      await expect(fees.createOne(JSON.stringify({ ...base, exchangeId: 1, definition: { currency: 'USD' } })))
        .rejects.toThrow(ValidationError);
      await expect(fees.createOne(JSON.stringify({ ...base, exchangeId: 1, source: 'GUESS' }))).rejects.toThrow(ValidationError);
      await expect(fees.deleteOne(JSON.stringify({ feeScheduleId: 1 }))).rejects.toThrow(ValidationError);
    });

    it('seeds Kalshi, Polymarket US, Hyperliquid and Lighter with definitions consumers can read', async () => {
      for (const statement of seedStatements()) await client.query(statement);
      const hyperliquid = (await client.query(`SELECT listing_id, fee_group FROM sm.listing WHERE exchange_id = 3 ORDER BY 1`)).rows;
      expect(hyperliquid).toEqual([{ listing_id: 700, fee_group: null }, { listing_id: 701, fee_group: 'spot' }]);
      const seeded = (await client.query(`SELECT definition FROM sm.fee_schedule`)).rows;
      expect(seeded).toHaveLength(25);
      for (const { definition } of seeded) expect(() => validateDefinition(definition)).not.toThrow();

      const [nfl, tableTennis, perp, spot] = await timeline([600, 601, 700, 701]);
      const takers = (t: any[]) => t.map((e) => e.definition.components[0].taker);
      expect(takers(nfl.timeline)).toEqual([0.05, 0.06, 0.0695]);
      expect(takers(tableTennis.timeline)).toEqual([0.05, 0.06, 0.0695, 0.10]);
      expect(takers(perp.timeline)).toEqual([0.00035, 0.00045]);
      // Spot traded at the perp schedule until it got its own.
      expect(takers(spot.timeline)).toEqual([0.00035, 0.0007]);

      // A Kalshi series with no recorded change: the original schedule, then the move to the rounding accumulator.
      const [kalshi] = await timeline([500]);
      expect(kalshi.timeline.map((e) => [e.effectiveFrom, e.definition.rounding.scope])).toEqual([
        ['1970-01-01T00:00:00.000Z', 'FILL'], ['2026-03-03T00:00:00.000Z', 'ORDER_ACCUMULATOR'],
      ]);
      await client.query(`UPDATE sm.listing SET fee_group = 'KXINX' WHERE listing_id = 502`);
      const [index] = await timeline([502], { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' });
      expect(takers(index.timeline)).toEqual([0.035]);
    });
  });
});
