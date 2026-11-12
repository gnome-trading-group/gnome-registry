import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { ValidationError } from '../lambda/endpoints/base';
import { IncentiveProgramHandler } from '../lambda/endpoints/incentive-programs';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// Kalshi (1) lists market KXRT-VIO-60 as YES (500) and NO (501), and another market (502); Polymarket Intl (2) lists
// both tokens of condition 0xabc (600, 601).
describeDb('Incentive programs, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  let handler: IncentiveProgramHandler;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE sm.incentive_program, sm.listing, sm.security, sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code) VALUES
      (1, 'K', 'us-east-1', 'KALSHI'), (2, 'P', 'eu-west-1', 'POLYMARKET_INTL')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES
      (1, 'VIO-YES', 4), (2, 'VIO-NO', 4), (3, 'OTHER', 4), (4, 'ABC-YES', 4), (5, 'ABC-NO', 4)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id,
      exchange_security_symbol) VALUES
      (500, 1, 1, 'KXRT-VIO-60', 'KXRT-VIO-60'), (501, 1, 2, 'KXRT-VIO-60:no', 'KXRT-VIO-60-NO'),
      (502, 1, 3, 'KXRT-OTHER-60', 'KXRT-OTHER-60'),
      (600, 2, 4, '0xabc:111', 'ABC-YES'), (601, 2, 5, '0xabc:222', 'ABC-NO')`);
    handler = new IncentiveProgramHandler();
    handler.client = client;
  });

  const kalshi = (fields: Record<string, unknown> = {}) => ({
    exchangeCode: 'KALSHI', venueProgramId: 'k1', program: 'LIQUIDITY', venueMarket: 'KXRT-VIO-60',
    periodStart: '2026-11-11T05:00:00Z', periodEnd: '2026-11-12T05:00:00Z', reward: '100.0000', rewardPer: 'PERIOD',
    definition: { targetSize: 1000, discountFactor: 0.5 }, paidOut: false, source: 'VENUE_API', raw: { id: 'k1' },
    ...fields,
  });

  async function post(rows: Record<string, unknown>[], h = handler) {
    const response = await h.createMany(JSON.stringify(rows));
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body) as { inserted: number; unchanged: number };
  }

  async function stored() {
    return (await client.query(`SELECT venue_program_id, reward::text, period_end, paid_out, effective_from, recorded_at
      FROM sm.incentive_program ORDER BY incentive_program_id`)).rows;
  }

  async function listing(listingId: number, query: Record<string, string> = {}) {
    const response = await handler.get({ listingIds: String(listingId), ...query });
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body)[0].programs as { venueProgramId: string; versions: any[] }[];
  }

  it('keeps a new program once, holding from its start when first seen after it began', async () => {
    expect(await post([kalshi()])).toEqual({ inserted: 1, unchanged: 0 });
    expect(await post([kalshi({ raw: { id: 'k1', note: 'raw changes alone are not news' } })]))
      .toEqual({ inserted: 0, unchanged: 1 });
    const [row] = await stored();
    expect(row.reward).toBe('100000000000');
    expect(row.effective_from.toISOString()).toBe('2026-11-11T05:00:00.000Z');
  });

  it('holds a program announced before its start from when it was recorded', async () => {
    const start = Date.now() + 2 * DAY;
    await post([kalshi({ periodStart: iso(start), periodEnd: iso(start + DAY) })]);
    const [row] = await stored();
    expect(row.effective_from.getTime()).toBeLessThan(start);
    expect(row.effective_from.getTime()).toBe(row.recorded_at.getTime());
  });

  it('records changed terms from now, so a cancellation before the start wins over the announcement', async () => {
    const start = Date.now() + 2 * DAY;
    await post([kalshi({ periodStart: iso(start), periodEnd: iso(start + DAY) })]);
    expect(await post([kalshi({ periodStart: iso(start), periodEnd: iso(Date.now()) })]))
      .toEqual({ inserted: 1, unchanged: 0 });
    const [announced, cancelled] = await stored();
    expect(cancelled.effective_from.getTime()).toBeGreaterThanOrEqual(announced.effective_from.getTime());
    expect(cancelled.period_end.getTime()).toBeLessThan(start);

    const [history] = await listing(500);
    expect(history.versions.map(v => v.periodEnd)).toEqual([iso(start + DAY), cancelled.period_end.toISOString()]);
    // Through the would-be period, the cancellation is the version in force: a period that ends before it starts.
    const [during] = await listing(500, { from: iso(start), to: iso(start + DAY) });
    expect(during.versions.map(v => v.periodEnd)).toEqual([cancelled.period_end.toISOString()]);
  });

  it('records a payout without moving when the terms took effect', async () => {
    await post([kalshi()]);
    expect(await post([kalshi({ paidOut: true })])).toEqual({ inserted: 1, unchanged: 0 });
    const [unpaid, paid] = await stored();
    expect(paid.paid_out).toBe(true);
    expect(paid.effective_from.getTime()).toBe(unpaid.effective_from.getTime());
    expect(paid.recorded_at.getTime()).toBeGreaterThanOrEqual(unpaid.recorded_at.getTime());

    const [program] = await listing(500);
    expect(program.versions).toHaveLength(1);
    expect(program.versions[0]).toMatchObject({ paidOut: true, reward: '100', rewardPer: 'PERIOD' });
  });

  it('reads as the registry knew it at knownAsOf', async () => {
    await post([kalshi()]);
    const before = (await client.query('SELECT NOW() AS now')).rows[0].now.toISOString();
    await new Promise(resolve => setTimeout(resolve, 10));
    await post([kalshi({ reward: '200' })]);
    expect((await listing(500)).flatMap(p => p.versions.map(v => v.reward))).toEqual(['100', '200']);
    expect((await listing(500, { knownAsOf: before })).flatMap(p => p.versions.map(v => v.reward))).toEqual(['100']);
  });

  it('gives a program to every listing of its market, and only those', async () => {
    await post([kalshi(), {
      ...kalshi(), exchangeCode: 'POLYMARKET_INTL', venueProgramId: '0xabc:0xc011:2026-11-11', venueMarket: '0xabc',
      periodEnd: null, reward: '5', rewardPer: 'DAY', paidOut: null,
      definition: { minSize: 20, maxSpreadCents: 4.5, asset: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' },
    }]);
    for (const id of [500, 501]) expect((await listing(id)).map(p => p.venueProgramId)).toEqual(['k1']);
    expect(await listing(502)).toEqual([]);
    for (const id of [600, 601]) {
      expect((await listing(id)).map(p => p.venueProgramId)).toEqual(['0xabc:0xc011:2026-11-11']);
    }
  });

  it('leaves out programs outside the window, and versions superseded before it', async () => {
    await post([kalshi()]);
    expect(await listing(500, { from: '2026-11-12T05:00:00Z' })).toEqual([]);
    expect(await listing(500, { to: '2026-11-11T05:00:00Z' })).toEqual([]);
    expect(await listing(500, { from: '2026-11-11T12:00:00Z', to: '2026-11-11T13:00:00Z' })).toHaveLength(1);
  });

  it('lists the programs still running, paged, as they can be posted again', async () => {
    const pm = (id: string, periodEnd: string | null) => ({
      ...kalshi(), exchangeCode: 'POLYMARKET_INTL', venueProgramId: id, venueMarket: '0xabc', periodEnd,
      reward: '1.5', rewardPer: 'DAY', paidOut: null,
      definition: { minSize: 20, maxSpreadCents: 4.5, asset: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' },
    });
    await post([pm('a', null), pm('b', null), pm('c', '2026-11-12T00:00:00Z'), pm('d', iso(Date.now() + DAY))]);
    // b ended since: its latest version is what counts.
    await post([pm('b', '2026-11-12T00:00:00Z')]);
    const page = async (after?: string) => JSON.parse((await handler.get({
      exchangeCode: 'POLYMARKET_INTL', limit: '1', ...(after ? { after } : {}),
    })).body) as { programs: any[]; next: string | null };
    const first = await page();
    expect(first.programs.map(p => p.venueProgramId)).toEqual(['a']);
    const second = await page(first.next!);
    expect(second.programs.map(p => p.venueProgramId)).toEqual(['d']);
    expect((await page(second.next!)).programs).toEqual([]);

    const { effectiveFrom: _, ...again } = first.programs[0];
    expect(await post([{ ...again, exchangeCode: 'POLYMARKET_INTL', source: 'VENUE_API' }]))
      .toEqual({ inserted: 0, unchanged: 1 });
  });

  it('refuses a post naming an exchange it does not have', async () => {
    await expect(handler.createMany(JSON.stringify([kalshi({ exchangeCode: 'NOWHERE' })]))).rejects.toThrow(ValidationError);
    expect(await stored()).toEqual([]);
  });

  it('keeps one row when two writers post the same new program at once', async () => {
    const other = await pool.connect();
    try {
      const second = new IncentiveProgramHandler();
      second.client = other;
      const results = await Promise.all([post([kalshi()]), post([kalshi()], second)]);
      expect(results.map(r => r.inserted).sort()).toEqual([0, 1]);
      expect(await stored()).toHaveLength(1);
    } finally {
      other.release();
    }
  });
});
