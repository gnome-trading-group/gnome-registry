import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { EventContractHandler } from '../lambda/endpoints/event-contracts';
import { ListingHandler } from '../lambda/endpoints/listings';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

// A Kalshi market: listing 10 trades YES (security 1, contract 1), listing 11 NO (security 2, contract 2); listing 12 is
// a perp, whose security no event contract names.
describeDb('listings awaiting settlement, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE sm.exchange, sm.security, sm.listing, sm.event, sm.event_contract RESTART IDENTITY CASCADE');
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'Kalshi', 'us-east-1', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'Y', 4), (2, 'N', 4), (3, 'P', 1)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, active)
      VALUES (10, 1, 1, 'M:yes', true), (11, 1, 2, 'M:no', true), (12, 1, 3, 'PERP', true)`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id) VALUES (1, 'E', 1, 'E')`);
    await client.query(`INSERT INTO sm.event_contract (event_contract_id, event_id, security_id, outcome_label)
      VALUES (1, 1, 1, 'Yes'), (2, 1, 2, 'No')`);
  });

  const listings = () => { const h = new ListingHandler(); h.client = client; return h; };
  const contracts = () => { const h = new EventContractHandler(); h.client = client; return h; };
  const awaiting = async () => (await client.query(
    'SELECT listing_id FROM sm.listing WHERE awaiting_settlement ORDER BY listing_id')).rows.map(r => r.listing_id);
  const patch = async (items: object[]) => expect((await listings().modifyMany(JSON.stringify(items))).statusCode).toBe(200);

  it('flags a listing turned off before its outcome settles, and not one with nothing to settle', async () => {
    await patch([{ listingId: 10, active: false }, { listingId: 12, active: false }]);
    expect(await awaiting()).toEqual([10]);
  });

  it('clears the flag when the outcome settles, leaving date_modified alone', async () => {
    await patch([{ listingId: 10, active: false }, { listingId: 11, active: false }]);
    const before = (await client.query('SELECT date_modified FROM sm.listing WHERE listing_id = 10')).rows[0].date_modified;
    const response = await contracts().modifyMany(JSON.stringify([{ eventContractId: 1, settlementPrice: 1_000_000_000 }]));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject([{ event_contract_id: 1, settlement_price: '1000000000' }]);
    expect(await awaiting()).toEqual([11]);
    const after = (await client.query('SELECT date_modified FROM sm.listing WHERE listing_id = 10')).rows[0].date_modified;
    expect(after).toEqual(before);
  });

  it('clears the flag when the listing is turned back on', async () => {
    await patch([{ listingId: 10, active: false }]);
    await patch([{ listingId: 10, active: true }]);
    expect(await awaiting()).toEqual([]);
  });

  it("doesn't flag a listing turned off after its outcome settled", async () => {
    await contracts().modifyMany(JSON.stringify([{ eventContractId: 1, settlementPrice: 0 }]));
    await patch([{ listingId: 10, active: false }]);
    expect(await awaiting()).toEqual([]);
  });

  it("leaves the flag alone on an edit that doesn't turn the listing on or off", async () => {
    await patch([{ listingId: 10, active: false }]);
    await patch([{ listingId: 10, exchangeSecuritySymbol: 'renamed' }, { listingId: 11, volume24h: 5 }]);
    expect(await awaiting()).toEqual([10]);
  });

  it('judges the security a listing is moved to in the same edit', async () => {
    await contracts().modifyMany(JSON.stringify([{ eventContractId: 2, settlementPrice: 0 }]));
    await patch([{ listingId: 10, securityId: 2, active: false }]);
    expect(await awaiting()).toEqual([]);
  });

  it('lets an outcome label edit through without touching listings', async () => {
    await patch([{ listingId: 10, active: false }]);
    const response = await contracts().modifyMany(JSON.stringify([{ eventContractId: 1, outcomeLabel: 'YES' }]));
    expect(JSON.parse(response.body)).toMatchObject([{ outcome_label: 'YES' }]);
    expect(await awaiting()).toEqual([10]);
  });
});
