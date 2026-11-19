import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { listingSpecs } from '../lambda/monitoring/rules/specs';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const now = new Date('2026-11-18T12:00:00Z');

describeDb('LISTING_SPEC_MISSING against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE sm.listing_spec, sm.listing, sm.security, sm.exchange RESTART IDENTITY CASCADE');
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI'), (2, 'Lighter', 'ap-northeast-1', 'LIGHTER')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'A', 4), (2, 'B', 1)`);
  });

  async function listing(id: number, exchangeId: number, symbol: string, active: boolean, createdMinutesAgo: number,
    withSpec = false) {
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id,
      exchange_security_symbol, active, date_created) VALUES ($1, $2, $2, $3, $3, $4, $5)`,
    [id, exchangeId, symbol, active, new Date(now.getTime() - createdMinutesAgo * 60_000)]);
    if (withSpec) {
      await client.query(`INSERT INTO sm.listing_spec (listing_id, price_bands, lot_size)
        VALUES ($1, '[{"start":0,"end":1000000000,"step":10000000}]', 10000)`, [id]);
    }
  }

  it("reports each exchange's active listings with no spec past five minutes, naming a few", async () => {
    await listing(1, 1, 'KX-A:yes', true, 30);
    await listing(2, 1, 'KX-B:yes', true, 10);
    await listing(3, 1, 'KX-C:yes', true, 2);
    await listing(4, 1, 'KX-D:yes', false, 30);
    await listing(5, 1, 'KX-E:yes', true, 30, true);
    await listing(6, 2, 'ETH', true, 60, true);

    const findings = await listingSpecs(client, now);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'LISTING_SPEC_MISSING', key: 'LISTING_SPEC_MISSING:KALSHI', exchangeId: 1, severity: 'warning',
      title: '2 active KALSHI listings have no spec', detail: 'e.g. KX-A:yes, KX-B:yes',
      since: '2026-11-18T11:30:00.000Z', facts: { missing: 2 }, visibleIn: ['live', 'paper'],
    });
  });

  it('finds nothing when every active listing has a spec', async () => {
    await listing(1, 1, 'KX-A:yes', true, 30, true);
    expect(await listingSpecs(client, now)).toEqual([]);
  });
});
