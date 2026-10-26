import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { withTransaction } from '../lambda/endpoints/base';
import { MARK_HEARTBEAT_MS, recordPollerMarks, unwatchedListings } from '../lambda/endpoints/ledger-poller-marks';
import { runRules } from '../lambda/monitoring/rules';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const now = new Date('2026-10-23T12:00:00Z');
const later = (ms: number) => new Date(now.getTime() + ms);

// Kalshi listings 500 (T:yes) and 501 (T:no) on one market, 502 (U:yes) on a market that settles.
describeDb('poller marks against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE alert.alert, ledger.fill, ledger.position, ledger.order, ledger.mark,
      strategy.session_listing, risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.listing_spec,
      sm.listing, sm.event_contract, sm.event, sm.security, sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'T-YES', 4), (2, 'T-NO', 4),
      (3, 'U-YES', 4)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id,
      exchange_security_symbol) VALUES (500, 1, 1, 'T:yes', 'T-YES'), (501, 1, 2, 'T:no', 'T-NO'),
      (502, 1, 3, 'U:yes', 'U-YES')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id) VALUES (1, 'T?', 1, 'T'),
      (2, 'U?', 1, 'U')`);
    await client.query(`INSERT INTO sm.event_contract (event_contract_id, event_id, security_id, outcome_label)
      VALUES (1, 1, 1, 'Yes'), (2, 1, 2, 'No'), (3, 2, 3, 'Yes')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('cs2'), ('mm')`);
  });

  async function hold(listingId: number, netQuantity = 10_000_000, strategyId = 1) {
    await client.query(`INSERT INTO ledger.position (strategy_id, listing_id, mode, net_quantity, total_cost, version)
      VALUES ($1, $2, 'paper', $3, 4000000000, 1)`, [strategyId, listingId, netQuantity]);
  }

  async function session(id: string, status: string, listings: number[], strategyId = 1) {
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
      VALUES ($1, $2, $3, 'paper', '{}', $4)`, [id, strategyId, status, now]);
    for (const listing of listings) {
      await client.query(`INSERT INTO strategy.session_listing VALUES ($1, $2, 'paper', $3, true)`, [id, strategyId, listing]);
    }
  }

  const post = (at: Date, marks: { listingId: number; bid: number; ask: number; lastTrade: number }[]) =>
    withTransaction(client, (c) => recordPollerMarks(c, JSON.stringify({
      marks: marks.map(m => ({ listingId: m.listingId, bid: String(m.bid), ask: String(m.ask), lastTrade: String(m.lastTrade) })),
    }), at));

  const marks = async (listingId: number) => (await client.query(
    `SELECT ts, bid::text, ask::text, last_trade::text, source FROM ledger.mark WHERE listing_id = $1 ORDER BY ts`,
    [listingId])).rows;

  const ids = async () => (await unwatchedListings(client)).map(r => r.listing_id);

  it('answers every post with the listings to price, after recording its marks', async () => {
    await hold(500);
    expect(await post(now, [])).toEqual({ received: 0, written: 0,
      listings: [{ listing_id: 500, exchange_code: 'KALSHI', exchange_security_id: 'T:yes' }] });
  });

  it('lists held listings no running session is on, in any strategy, and skips settled and flat ones', async () => {
    await hold(500);
    await hold(501, -5_000_000, 2);
    await hold(502);
    expect(await ids()).toEqual([500, 501, 502]);

    await client.query('UPDATE sm.event_contract SET settlement_price = 0, settled_at = NOW() WHERE event_contract_id = 3');
    expect(await ids()).toEqual([500, 501]);

    await session('mm-running', 'RUNNING', [501], 2);
    expect(await ids()).toEqual([500]);

    await client.query('UPDATE ledger.position SET net_quantity = 0 WHERE listing_id = 500');
    expect(await ids()).toEqual([]);
  });

  it('keeps pricing a listing until its session is running, and again once it stops', async () => {
    await hold(500);
    await session('s1', 'SUBMITTED', [500]);
    expect(await ids()).toEqual([500]);
    await client.query(`UPDATE strategy.session SET status = 'RUNNING' WHERE session_id = 's1'`);
    expect(await ids()).toEqual([]);
    await client.query(`UPDATE strategy.session SET status = 'STOPPING' WHERE session_id = 's1'`);
    expect(await ids()).toEqual([]);
    await client.query(`UPDATE strategy.session SET status = 'STOPPED' WHERE session_id = 's1'`);
    expect(await ids()).toEqual([500]);
    expect(await unwatchedListings(client)).toEqual([{ listing_id: 500, exchange_code: 'KALSHI', exchange_security_id: 'T:yes' }]);
  });

  it('records a change at once and a quiet book every few minutes, as the poller\'s', async () => {
    const quote = { listingId: 500, bid: 400_000_000, ask: 420_000_000, lastTrade: 410_000_000 };
    expect(await post(now, [quote])).toMatchObject({ received: 1, written: 1 });
    expect(await post(later(60_000), [quote])).toMatchObject({ received: 1, written: 0 });
    expect(await post(later(120_000), [{ ...quote, bid: 405_000_000 }])).toMatchObject({ received: 1, written: 1 });
    expect(await post(later(120_000 + MARK_HEARTBEAT_MS - 1), [{ ...quote, bid: 405_000_000 }])).toMatchObject({ received: 1, written: 0 });
    expect(await post(later(120_000 + MARK_HEARTBEAT_MS), [{ ...quote, bid: 405_000_000 }])).toMatchObject({ received: 1, written: 1 });
    expect((await marks(500)).map(m => [m.bid, m.source])).toEqual([
      ['400000000', 'POLLER'], ['405000000', 'POLLER'], ['405000000', 'POLLER'],
    ]);
  });

  it('keeps the last known trade when the venue reports none, and never records a reading with no price', async () => {
    await client.query(`INSERT INTO ledger.mark (listing_id, ts, bid, ask, last_trade) VALUES (500, $1, 0, 0, 380000000)`,
      [later(-3_600_000)]);
    expect(await post(now, [{ listingId: 500, bid: 0, ask: 0, lastTrade: 0 }])).toMatchObject({ received: 1, written: 1 });
    expect(await post(now, [{ listingId: 501, bid: 0, ask: 0, lastTrade: 0 }])).toMatchObject({ received: 1, written: 0 });
    expect(await post(later(60_000), [{ listingId: 500, bid: 390_000_000, ask: 0, lastTrade: 0 }]))
      .toMatchObject({ received: 1, written: 1 });
    expect((await marks(500)).map(m => [m.bid, m.ask, m.last_trade, m.source])).toEqual([
      ['0', '0', '380000000', 'SESSION'], ['0', '0', '380000000', 'POLLER'], ['390000000', '0', '380000000', 'POLLER'],
    ]);
    expect(await marks(501)).toEqual([]);
  });

  it('leaves a listing a session started on since the poll to that session, and ignores unknown listings', async () => {
    await session('s1', 'RUNNING', [500]);
    expect(await post(now, [
      { listingId: 500, bid: 400_000_000, ask: 420_000_000, lastTrade: 0 },
      { listingId: 501, bid: 580_000_000, ask: 600_000_000, lastTrade: 0 },
      { listingId: 999, bid: 1, ask: 2, lastTrade: 0 },
    ])).toMatchObject({ received: 3, written: 1 });
    expect(await marks(500)).toEqual([]);
    expect((await marks(501)).length).toBe(1);
  });

  it('never writes behind a newer mark', async () => {
    await client.query(`INSERT INTO ledger.mark (listing_id, ts, bid, ask, last_trade) VALUES (500, $1, 1, 2, 0)`, [later(1_000)]);
    expect(await post(now, [{ listingId: 500, bid: 400_000_000, ask: 420_000_000, lastTrade: 0 }]))
      .toMatchObject({ received: 1, written: 0 });
  });

  it('refuses a body that is not marks in price units', async () => {
    for (const body of [{}, { marks: [{ listingId: 0, bid: '1', ask: '1', lastTrade: '0' }] },
      { marks: [{ listingId: 500, bid: '-1', ask: '1', lastTrade: '0' }] },
      { marks: [{ listingId: 500, bid: 1, ask: '1', lastTrade: '0' }] }]) {
      await expect(withTransaction(client, (c) => recordPollerMarks(c, JSON.stringify(body), now))).rejects.toThrow();
    }
  });

  it('says where to look when a held listing no session is on has no price, and stays quiet once settled', async () => {
    await hold(500);
    await hold(502);
    await session('s1', 'RUNNING', [501]);
    await hold(501);
    const noPrice = async () => (await runRules(client, now)).filter(f => f.kind === 'NO_PRICE')
      .map(f => [f.listingId, f.detail]).sort((a, b) => Number(a[0]) - Number(b[0]));
    expect(await noPrice()).toEqual([
      [500, 'No session is on the listing and the mark poller has no price for it; valued at its last known price'],
      [501, 'Valued at its last known price'],
      [502, 'No session is on the listing and the mark poller has no price for it; valued at its last known price'],
    ]);

    await post(now, [{ listingId: 500, bid: 400_000_000, ask: 420_000_000, lastTrade: 0 }]);
    await client.query('UPDATE sm.event_contract SET settlement_price = 0, settled_at = NOW() WHERE event_contract_id = 3');
    expect((await noPrice()).map(([listingId]) => listingId)).toEqual([501]);
  });
});
