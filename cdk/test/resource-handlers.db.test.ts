import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { ResourceHandler } from '../lambda/endpoints/base';
import { ContractRelationshipHandler } from '../lambda/endpoints/contract-relationships';
import { EventHandler } from '../lambda/endpoints/events';
import { ExchangeHandler } from '../lambda/endpoints/exchanges';
import { ListingHandler } from '../lambda/endpoints/listings';
import { RiskPolicyHandler } from '../lambda/endpoints/risk-policies';
import { SecurityHandler } from '../lambda/endpoints/securities';
import { StrategyHandler } from '../lambda/endpoints/strategies';
import { StrategySessionHandler } from '../lambda/endpoints/strategy-sessions';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

// Values a string-built query would have broken on.
const AWKWARD = "O'Brien's \\ 100% _done_";

describeDb('resource handlers round-trip awkward values, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query('TRUNCATE sm.exchange, sm.security, sm.event, strategy.strategy, risk.policy RESTART IDENTITY CASCADE');
  });

  function on<T extends ResourceHandler>(handler: T): T {
    handler.client = client;
    return handler;
  }

  async function ok(response: Promise<{ statusCode: number; body: string }>): Promise<any> {
    const { statusCode, body } = await response;
    expect({ statusCode, body }).toEqual({ statusCode: 200, body: expect.anything() });
    return JSON.parse(body);
  }

  async function exchange(): Promise<number> {
    const row = await ok(on(new ExchangeHandler()).createOne(JSON.stringify({
      exchangeCode: 'KALSHI', exchangeName: AWKWARD, region: 'us-east-1',
    })));
    return row.exchange_id;
  }

  async function listing(exchangeId: number): Promise<number> {
    const security = await ok(on(new SecurityHandler()).createOne(JSON.stringify({
      symbol: AWKWARD, description: AWKWARD, type: 1,
    })));
    const row = await ok(on(new ListingHandler()).createOne(JSON.stringify({
      exchangeId, securityId: security.security_id, exchangeSecurityId: AWKWARD, exchangeSecuritySymbol: AWKWARD,
      feeGroup: AWKWARD,
    })));
    return row.listing_id;
  }

  it('exchanges: create, filter, modify, count and delete', async () => {
    const exchanges = on(new ExchangeHandler());
    const id = await exchange();
    expect(await ok(exchanges.get({ exchangeName: AWKWARD }))).toMatchObject([{ exchange_id: id, exchange_name: AWKWARD }]);
    expect(await ok(exchanges.get({ count: 'true', exchangeName: AWKWARD }))).toEqual({ count: 1 });
    expect(await ok(exchanges.get({ exchangeName: "O'Brien" }))).toEqual([]);
    expect(await ok(exchanges.modifyOne({ exchangeId: String(id) }, JSON.stringify({ region: AWKWARD }))))
      .toMatchObject({ region: AWKWARD, exchange_name: AWKWARD });
    expect((await exchanges.deleteOne(JSON.stringify({ exchangeId: id }))).statusCode).toBe(200);
  });

  it('securities and listings: denormalized search, id lists and clearing a fee key', async () => {
    const listingId = await listing(await exchange());
    const listings = on(new ListingHandler());
    expect(await ok(listings.get({ denormalize: 'true', search: "brien's" })))
      .toMatchObject([{ listing_id: listingId, security_symbol: AWKWARD, fee_group: AWKWARD }]);
    expect(await ok(listings.get({ listingIds: `${listingId},99` }))).toHaveLength(1);
    expect(await ok(listings.get({ exchangeSecurityId: AWKWARD }))).toHaveLength(1);
    expect(await ok(listings.modifyOne({ listingId: String(listingId) }, JSON.stringify({ feeGroup: null }))))
      .toMatchObject({ fee_group: null, exchange_security_symbol: AWKWARD });
    expect(await ok(on(new SecurityHandler()).get({ symbol: AWKWARD }))).toMatchObject([{ description: AWKWARD }]);
  });

  it('events: tags, nullable fields and a volume refresh', async () => {
    const exchangeId = await exchange();
    const events = on(new EventHandler());
    const created = await ok(events.createOne(JSON.stringify({
      title: AWKWARD, description: AWKWARD, category: AWKWARD, tags: [AWKWARD, 'nfl'], exchangeId,
      nativeEventId: AWKWARD, nativeUrl: AWKWARD, volume24h: 12.5,
    })));
    expect(created).toMatchObject({ title: AWKWARD, tags: [AWKWARD, 'nfl'], volume_24h: 12.5 });
    expect(created.volume_updated_at).not.toBeNull();
    for (const params of [{ tag: AWKWARD }, { tags: `x,${AWKWARD}` }, { categories: AWKWARD }, { search: "'s" },
      { nativeEventId: AWKWARD }]) {
      expect(await ok(events.get(params))).toHaveLength(1);
    }
    expect(await ok(events.modifyOne({ eventId: String(created.event_id) },
      JSON.stringify({ description: null, tags: [], resolved: true }))))
      .toMatchObject({ description: null, tags: null, resolved: true, title: AWKWARD });
  });

  it('strategies and sessions: jsonb, status guards and first-stop-wins', async () => {
    const listingId = await listing(await exchange());
    const strategy = await ok(on(new StrategyHandler()).createOne(JSON.stringify({
      name: AWKWARD, description: AWKWARD, parameters: { list: [1, 2], text: AWKWARD },
    })));
    expect(strategy.parameters).toEqual({ list: [1, 2], text: AWKWARD });

    const sessions = on(new StrategySessionHandler());
    await ok(sessions.createOne(JSON.stringify({
      sessionId: 's-1', strategyId: strategy.strategy_id, status: 'SUBMITTED', mode: 'paper',
      config: { listings: [listingId], note: AWKWARD }, researchCommit: AWKWARD,
    })));
    expect(await ok(sessions.get({ status: 'SUBMITTED,RUNNING', listingId: String(listingId) })))
      .toMatchObject([{ session_id: 's-1', config: { listings: [listingId], note: AWKWARD }, research_commit: AWKWARD }]);

    const stop = (stopReason: string, expectedStatus: string[]) => sessions.modifyOne({ sessionId: 's-1' },
      JSON.stringify({ status: 'STOPPING', stopReason, stoppedBy: AWKWARD, failureReason: AWKWARD, expectedStatus }));
    expect(await ok(stop(AWKWARD, ['SUBMITTED']))).toMatchObject({ status: 'STOPPING', stop_reason: AWKWARD });
    expect((await stop('later', ['SUBMITTED'])).statusCode).toBe(409);
    expect(await ok(stop('later', ['STOPPING']))).toMatchObject({ stop_reason: AWKWARD, stopped_by: AWKWARD });
  });

  it('risk policies: a session row takes its strategy from the session', async () => {
    const listingId = await listing(await exchange());
    const strategy = await ok(on(new StrategyHandler()).createOne(JSON.stringify({ name: 'mm' })));
    await ok(on(new StrategySessionHandler()).createOne(JSON.stringify({
      sessionId: 's-2', strategyId: strategy.strategy_id, status: 'SUBMITTED', mode: 'paper',
      config: { listings: [listingId] },
    })));
    const policies = on(new RiskPolicyHandler());
    expect(await ok(policies.createOne(JSON.stringify({ policyType: 'KILL_SWITCH', sessionId: 's-2', parameters: {} }))))
      .toMatchObject({ session_id: 's-2', strategy_id: strategy.strategy_id, parameters: {}, enabled: true });
    expect(await ok(policies.get({ forStrategy: String(strategy.strategy_id), forSession: 's-2',
      forListings: String(listingId) }))).toHaveLength(1);
  });

  it('contract relationships: a classifier write never replaces a manual row', async () => {
    const security = async (symbol: string) => (await ok(on(new SecurityHandler()).createOne(JSON.stringify({
      symbol, description: symbol, type: 1,
    })))).security_id;
    const [a, b, c] = [await security('a'), await security('b'), await security('c')];
    const relationships = on(new ContractRelationshipHandler());
    const rel = (securityIdA: number, securityIdB: number, relationshipType: string, method: string) => ({
      securityIdA, securityIdB, relationshipType, confidence: 0.9, method,
    });

    await ok(relationships.createOne(JSON.stringify(rel(a, b, 'EQUIVALENT', 'manual'))));
    await ok(relationships.createOne(JSON.stringify(rel(a, c, 'IMPLIES', 'embedding'))));
    const bulk = await ok(relationships.createMany(JSON.stringify([
      rel(a, b, 'IMPLIES', 'embedding'),
      rel(a, c, 'EQUIVALENT', 'embedding'),
    ])));
    expect(bulk).toMatchObject([
      { security_id_b: b, relationship_type: 'EQUIVALENT', method: 'manual' },
      { security_id_b: c, relationship_type: 'EQUIVALENT', method: 'embedding' },
    ]);

    expect(await ok(relationships.createOne(JSON.stringify(rel(a, b, 'IMPLIES', 'manual')))))
      .toMatchObject({ relationship_type: 'IMPLIES', method: 'manual' });
    expect(await ok(relationships.createOne(JSON.stringify(rel(a, c, 'IMPLIES', 'manual')))))
      .toMatchObject({ relationship_type: 'IMPLIES', method: 'manual' });
  });

  it('refuses a value Postgres cannot read as the column type', async () => {
    await exchange();
    await expect(on(new ExchangeHandler()).get({ exchangeId: 'abc' })).rejects.toMatchObject({ code: '22P02' });
  });
});
