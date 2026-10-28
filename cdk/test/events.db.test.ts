import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { ValidationError } from '../lambda/endpoints/base';
import { EventHandler } from '../lambda/endpoints/events';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

// Kalshi (exchange 1) and Polymarket (exchange 2): events 1-3 on Kalshi, 4 on Polymarket; 3 is resolved and 2 has no
// volume yet.
describeDb('events by volume, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE sm.exchange RESTART IDENTITY CASCADE');
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI'), (2, 'Polymarket', 'eu-west-2', 'POLYMARKET_INTL')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id, category, tags, expiry,
        resolved, volume_24h, volume_updated_at, date_modified) VALUES
      (1, 'A', 1, 'A', 'Sports', ARRAY['nfl'], '2026-11-01', false, 5000, NOW(), '2026-10-01'),
      (2, 'B', 1, 'B', 'Politics', ARRAY['us'], '2026-12-01', false, NULL, NULL, '2026-10-01'),
      (3, 'C', 1, 'C', 'Sports', ARRAY['nba', 'nfl'], '2026-11-15', true, 90000, NOW(), '2026-10-01'),
      (4, 'D', 2, 'D', 'Sports', ARRAY['nfl'], '2026-11-02', false, 20000, NOW(), '2026-10-01')`);
  });

  function handler(): EventHandler {
    const events = new EventHandler();
    events.client = client;
    return events;
  }

  async function ids(params: Record<string, string>): Promise<number[]> {
    const response = await handler().get(params);
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body).map((e: any) => e.event_id);
  }

  it('filters by exchanges, categories, any of the tags, expiry window and minimum volume', async () => {
    expect(await ids({ exchangeIds: '1,2', resolved: 'false' })).toEqual([1, 2, 4]);
    expect(await ids({ categories: 'Sports,Weather' })).toEqual([1, 3, 4]);
    expect(await ids({ tags: 'nba,us' })).toEqual([2, 3]);
    expect(await ids({ expiryFrom: '2026-11-02T00:00:00Z', expiryTo: '2026-12-01T00:00:00Z' })).toEqual([3, 4]);
    expect(await ids({ minVolume24h: '10000' })).toEqual([3, 4]);
    expect(await ids({ exchangeIds: '' })).toEqual([]);
    expect(await ids({ eventIds: '2,3,99' })).toEqual([2, 3]);
    expect(await ids({ eventIds: '2,3', resolved: 'true' })).toEqual([3]);
  });

  it('sorts by volume either way with events lacking one last, and pages stably', async () => {
    expect(await ids({ sortBy: 'volume_24h', sortOrder: 'desc' })).toEqual([3, 4, 1, 2]);
    expect(await ids({ sortBy: 'volume_24h', sortOrder: 'asc' })).toEqual([1, 4, 3, 2]);
    expect(await ids({ sortBy: 'volume_24h', sortOrder: 'desc', resolved: 'false', limit: '2' })).toEqual([4, 1]);
    expect(await ids({ sortBy: 'volume_24h', sortOrder: 'desc', limit: '2', offset: '2' })).toEqual([1, 2]);
  });

  it('refuses a filter that is not a time or a number', async () => {
    await expect(handler().get({ expiryFrom: "x'; DROP TABLE sm.event; --" })).rejects.toThrow(ValidationError);
    await expect(handler().get({ minVolume24h: 'lots' })).rejects.toThrow(ValidationError);
  });

  it('records a volume reading with its time and leaves the event\'s modified time alone', async () => {
    const response = await handler().modifyMany(JSON.stringify([
      { eventId: 2, volume24h: 1234.5 }, { eventId: 1, volume24h: null },
    ]));
    expect(response.statusCode).toBe(200);
    const rows = (await client.query(`SELECT event_id, volume_24h, volume_updated_at > NOW() - INTERVAL '1 minute' AS fresh,
      date_modified::date::text AS modified FROM sm.event WHERE event_id IN (1, 2) ORDER BY event_id`)).rows;
    expect(rows).toEqual([
      { event_id: 1, volume_24h: null, fresh: true, modified: '2026-10-01' },
      { event_id: 2, volume_24h: 1234.5, fresh: true, modified: '2026-10-01' },
    ]);
  });

  it('still stamps the modified time when an edit carries other fields', async () => {
    await handler().modifyMany(JSON.stringify([{ eventId: 4, title: 'D2', volume24h: 1 }]));
    const { rows } = await client.query(`SELECT title, volume_24h, date_modified > NOW() - INTERVAL '1 minute' AS touched
      FROM sm.event WHERE event_id = 4`);
    expect(rows).toEqual([{ title: 'D2', volume_24h: 1, touched: true }]);
  });
});
