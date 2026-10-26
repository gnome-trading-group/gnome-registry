import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { ValidationError } from '../lambda/endpoints/base';
import { ListingHandler } from '../lambda/endpoints/listings';
import { SourceHandler } from '../lambda/endpoints/sources';
import { StreamHandler } from '../lambda/endpoints/streams';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

// Kalshi (exchange 1, us-east-1) and Hyperliquid (exchange 3, ap-northeast-1); listings 500 and 501 trade on Kalshi.
describeDb('market-data sources and streams, against Postgres', () => {
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
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI'), (3, 'Hyperliquid', 'ap-northeast-1', 'HYPERLIQUID')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'X', 4), (2, 'Y', 4)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, active)
      VALUES (500, 1, 1, 'MKT:yes', true), (501, 1, 1, 'MKT:no', false)`);
  });

  function withClient<T extends { client: any }>(handler: T): T {
    handler.client = client;
    return handler;
  }

  async function streamsFor(listingId: number) {
    return (await client.query('SELECT * FROM md.stream WHERE listing_id = $1', [listingId])).rows;
  }

  async function getStreams(params: Record<string, string>) {
    const response = await withClient(new StreamHandler()).get(params);
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body);
  }

  it('gives every exchange a venue source named after its code', async () => {
    const sources = (await client.query('SELECT code, kind, exchange_id, home_region, families FROM md.source ORDER BY exchange_id')).rows;
    expect(sources).toEqual([
      { code: 'KALSHI', kind: 'VENUE', exchange_id: 1, home_region: null, families: ['book'] },
      { code: 'HYPERLIQUID', kind: 'VENUE', exchange_id: 3, home_region: null, families: ['book'] },
    ]);
  });

  it('gives every listing exactly one book stream, whichever way it is created', async () => {
    const listings = withClient(new ListingHandler());
    await listings.createOne(JSON.stringify(
      { exchangeId: 3, securityId: 2, exchangeSecurityId: 'BTC', exchangeSecuritySymbol: 'BTC' }));
    await listings.createMany(JSON.stringify([
      { exchangeId: 3, securityId: 1, exchangeSecurityId: 'ETH', exchangeSecuritySymbol: 'ETH' },
      { exchangeId: 3, securityId: 1, exchangeSecurityId: 'SOL', exchangeSecuritySymbol: 'SOL' },
    ]));

    const counts = (await client.query(`
      SELECT l.listing_id, COUNT(s.stream_id)::int AS streams, MIN(s.family) AS family
      FROM sm.listing l LEFT JOIN md.stream s ON s.listing_id = l.listing_id
      GROUP BY l.listing_id ORDER BY l.listing_id`)).rows;
    expect(counts).toHaveLength(5);
    expect(counts.every((r) => r.streams === 1 && r.family === 'book')).toBe(true);
  });

  it('creates no stream when the listing insert fails, and none of a failed bulk insert', async () => {
    const listings = withClient(new ListingHandler());
    const duplicate = { exchangeId: 1, securityId: 1, exchangeSecurityId: 'MKT:yes', exchangeSecuritySymbol: 'dup' };
    await expect(listings.createMany(JSON.stringify([
      { exchangeId: 3, securityId: 2, exchangeSecurityId: 'BTC', exchangeSecuritySymbol: 'BTC' },
      duplicate,
    ]))).rejects.toThrow();
    expect((await client.query('SELECT COUNT(*)::int AS n FROM md.stream')).rows[0].n).toBe(2);
  });

  it('removes a listing\'s stream with the listing', async () => {
    await client.query('DELETE FROM sm.listing WHERE listing_id = 501');
    expect(await streamsFor(501)).toEqual([]);
  });

  it('refuses a listing stream that carries its own subject id, and a vendor without a home region', async () => {
    await expect(client.query(`INSERT INTO md.stream (source_id, subject_kind, listing_id, native_subject_id, family)
      SELECT source_id, 'LISTING', 500, 'MKT:yes', 'book' FROM md.source WHERE code = 'KALSHI'`)).rejects.toThrow(/check/);
    await expect(client.query(`INSERT INTO md.source (code, kind, adapter, families)
      VALUES ('PANDASCORE', 'VENDOR', 'PANDASCORE', ARRAY['esports'])`)).rejects.toThrow(/check/);
  });

  it('reads a listing stream with its venue key, active flag and exchange region', async () => {
    const [stream] = await getStreams({ listingId: '501' });
    expect(stream).toMatchObject({
      source_code: 'KALSHI', source_kind: 'VENUE', subject_kind: 'LISTING', listing_id: 501,
      native_subject_id: 'MKT:no', family: 'book', region: null, resolved_region: 'us-east-1', active: false,
    });
  });

  it('filters streams by listings, family and active, and resolves a vendor stream to its home region', async () => {
    const sources = withClient(new SourceHandler());
    const created = await sources.createOne(JSON.stringify(
      { code: 'PANDASCORE', homeRegion: 'eu-west-1', adapter: 'PANDASCORE', families: ['esports'] }));
    expect(created.statusCode).toBe(200);
    const vendor = JSON.parse(created.body);
    await client.query(`INSERT INTO md.stream (source_id, subject_kind, native_subject_id, family, active)
      VALUES ($1, 'MATCH', '12345', 'esports', true)`, [vendor.source_id]);

    expect((await getStreams({ listingIds: '500,501' })).map((s: any) => s.listing_id)).toEqual([500, 501]);
    expect((await getStreams({ active: 'true' })).map((s: any) => s.native_subject_id)).toEqual(['MKT:yes', '12345']);
    const [match] = await getStreams({ family: 'esports' });
    expect(match).toMatchObject({ source_code: 'PANDASCORE', subject_kind: 'MATCH', resolved_region: 'eu-west-1' });
  });

  it('lets a vendor source be edited but not a venue source\'s region', async () => {
    const sources = withClient(new SourceHandler());
    await expect(sources.modifyOne({ code: 'KALSHI' }, JSON.stringify({ homeRegion: 'eu-west-1' })))
      .rejects.toThrow(ValidationError);

    await sources.createOne(JSON.stringify(
      { code: 'PANDASCORE', homeRegion: 'eu-west-1', adapter: 'PANDASCORE', families: ['esports'] }));
    const vendor = await sources.modifyOne({ code: 'PANDASCORE' }, JSON.stringify({ homeRegion: 'us-east-1', active: false }));
    expect(JSON.parse(vendor.body)).toMatchObject({ home_region: 'us-east-1', active: false });
  });
});
