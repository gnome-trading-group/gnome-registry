import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { ValidationError } from '../lambda/endpoints/base';
import { ListingHandler } from '../lambda/endpoints/listings';
import { SecurityHandler } from '../lambda/endpoints/securities';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

// Hyperliquid (3) and Lighter (4) perps and spot, and a Kalshi (1) contract with no volume.
describeDb('listings by 24h volume, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE sm.listing, sm.security, sm.exchange, md.source, md.stream RESTART IDENTITY CASCADE');
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI'), (3, 'Hyperliquid', 'ap-northeast-1', 'HYPERLIQUID'),
             (4, 'Lighter', 'ap-northeast-1', 'LIGHTER')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type)
      VALUES (1, 'BTC-USDC-PERP', 1), (2, 'ETH-USDC-PERP', 1), (3, 'HYPE-USDC-SPOT', 0), (4, 'X', 4)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, active, volume_24h)
      VALUES (10, 3, 1, 'BTC', true, 2700000000), (11, 3, 2, 'ETH', true, 720000000), (12, 3, 3, '@107', true, 91000000),
             (13, 4, 1, '1', true, 820000000), (14, 4, 2, '0', true, NULL), (15, 3, 2, 'xyz:ETH', false, 900000000),
             (16, 1, 4, 'MKT:yes', true, NULL)`);
  });

  function handler(): ListingHandler {
    const listings = new ListingHandler();
    listings.client = client;
    return listings;
  }

  async function ids(params: Record<string, string>): Promise<number[]> {
    const response = await handler().get(params);
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body).map((row: { listing_id: number }) => row.listing_id);
  }

  it('ranks active listings of the given exchanges and security types by volume, largest first', async () => {
    expect(await ids({ exchangeIds: '3,4', securityTypes: '1', active: 'true', sortBy: 'volume_24h', sortOrder: 'desc' }))
      .toEqual([10, 13, 11, 14]);
    expect(await ids({ exchangeIds: '3', securityTypes: '0,1', active: 'true', sortBy: 'volume_24h', sortOrder: 'desc' }))
      .toEqual([10, 11, 12]);
  });

  it('keeps only listings at or above a minimum volume, leaving out those with none', async () => {
    expect(await ids({ exchangeIds: '3,4', minVolume24h: '800000000', sortBy: 'volume_24h', sortOrder: 'desc' }))
      .toEqual([10, 15, 13]);
  });

  it('filters the same way when denormalized', async () => {
    expect(await ids({
      exchangeIds: '3,4', securityTypes: '1', minVolume24h: '1', active: 'true', denormalize: 'true',
      sortBy: 'volume_24h', sortOrder: 'desc', limit: '2',
    })).toEqual([10, 13]);
  });

  it('searches denormalized listings by their own symbol only', async () => {
    await client.query(`UPDATE sm.listing SET exchange_security_symbol = 'Bitcoin perp' WHERE listing_id = 13`);
    await client.query(`UPDATE sm.listing SET exchange_security_symbol = 'Ether perp' WHERE listing_id IN (11, 14, 15)`);
    const search = (term: string, extra: Record<string, string> = {}) => ids({ denormalize: 'true', search: term, ...extra });
    expect(await search('bitcoin')).toEqual([13]);
    expect(await search('PERP')).toEqual([11, 13, 14, 15]);
    expect(await search('perp', { active: 'true', exchangeId: '3' })).toEqual([11]);
    expect(await search('btc-usdc')).toEqual([]);
    expect(await search('lighter')).toEqual([]);
    expect(await search('16')).toEqual([]);
    const count = await handler().get({ denormalize: 'true', search: 'ether', count: 'true' });
    expect(JSON.parse(count.body)).toEqual({ count: 3 });
  });

  it('counts denormalized listings the same as the rows it returns', async () => {
    const filters: Record<string, string>[] = [{}, { active: 'true' }, { exchangeIds: '3', securityTypes: '1' }];
    for (const filter of filters) {
      const rows = await ids({ denormalize: 'true', ...filter });
      const count = await handler().get({ denormalize: 'true', count: 'true', ...filter });
      expect(JSON.parse(count.body)).toEqual({ count: rows.length });
    }
  });

  it('pages newest first through listings created together without repeating or skipping one', async () => {
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, active, date_created)
      SELECT n, 1, 4, 'BULK' || n, n % 3 <> 0, '2026-11-01' FROM generate_series(100, 129) n`);
    const filters: Record<string, string>[] = [{ exchangeId: '1' }, { exchangeId: '1', active: 'true' }];
    for (const filter of filters) {
      const params = { ...filter, denormalize: 'true', sortBy: 'date_created', sortOrder: 'desc' };
      const all = await ids({ ...params, limit: '100' });
      const pages: number[] = [];
      for (let offset = 0; offset < all.length; offset += 7) {
        pages.push(...await ids({ ...params, limit: '7', offset: String(offset) }));
      }
      expect(pages).toEqual(all);
      expect(new Set(pages).size).toBe(all.length);
    }
    expect(await ids({ exchangeId: '1', sortBy: 'date_created', sortOrder: 'desc', limit: '3' })).toEqual([16, 129, 128]);
  });

  it('pages securities created together newest first, and searches them by symbol', async () => {
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, date_created)
      SELECT n, 'BULK-' || n, 4, '2020-01-01' FROM generate_series(100, 129) n`);
    const securities = new SecurityHandler();
    securities.client = client;
    const get = async (params: Record<string, string>) =>
      JSON.parse((await securities.get(params)).body).map((row: { security_id: number }) => row.security_id);
    const params = { sortBy: 'date_created', sortOrder: 'asc', search: 'bulk-' };
    const all = await get({ ...params, limit: '100' });
    const pages: number[] = [];
    for (let offset = 0; offset < all.length; offset += 7) {
      pages.push(...await get({ ...params, limit: '7', offset: String(offset) }));
    }
    expect(all).toHaveLength(30);
    expect(pages).toEqual(all);
    expect(all.slice(0, 3)).toEqual([100, 101, 102]);
    expect(await get({ search: 'usdc-perp' })).toEqual([1, 2]);
    expect(JSON.parse((await securities.get({ search: 'bulk-12', count: 'true' })).body)).toEqual({ count: 10 });
  });

  it('refuses a security type that is not a code', async () => {
    await expect(handler().get({ securityTypes: 'PERPETUAL' })).rejects.toThrow(ValidationError);
  });

  it('records a volume reading without counting it as an edit of the listing', async () => {
    await client.query(`UPDATE sm.listing SET date_modified = '2026-01-01' WHERE listing_id IN (10, 11)`);
    const response = await handler().modifyMany(JSON.stringify([
      { listingId: 10, volume24h: 3000000000 },
      { listingId: 11, active: false, volume24h: 0 },
    ]));
    expect(response.statusCode).toBe(200);

    const rows = (await client.query(`SELECT listing_id, active, volume_24h, volume_updated_at IS NOT NULL AS read,
        date_modified > '2026-01-02' AS edited FROM sm.listing WHERE listing_id IN (10, 11) ORDER BY listing_id`)).rows;
    expect(rows).toEqual([
      { listing_id: 10, active: true, volume_24h: 3000000000, read: true, edited: false },
      { listing_id: 11, active: false, volume_24h: 0, read: true, edited: true },
    ]);
  });

  it('creates a listing with its volume and active flag', async () => {
    await handler().createOne(JSON.stringify({
      exchangeId: 3, securityId: 1, exchangeSecurityId: 'MATIC', exchangeSecuritySymbol: 'MATIC', active: false,
      volume24h: 0,
    }));
    await handler().createOne(JSON.stringify({
      exchangeId: 3, securityId: 2, exchangeSecurityId: 'SOL', exchangeSecuritySymbol: 'SOL',
    }));

    const rows = (await client.query(`SELECT exchange_security_id, active, volume_24h,
        volume_updated_at IS NOT NULL AS read FROM sm.listing WHERE exchange_security_id IN ('MATIC', 'SOL') ORDER BY exchange_security_id`)).rows;
    expect(rows).toEqual([
      { exchange_security_id: 'MATIC', active: false, volume_24h: 0, read: true },
      { exchange_security_id: 'SOL', active: true, volume_24h: null, read: false },
    ]);
  });
});
