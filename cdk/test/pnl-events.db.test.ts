import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { events } from '../lambda/endpoints/pnl-events';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const CENT = 10_000_000;
const UNIT = 1_000_000;
const cents = (value: number) => String(value * CENT);
const now = new Date('2026-10-07T12:00:00Z');

describeDb('positions by event against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.event_contract, sm.event, sm.listing_spec,
      sm.listing, sm.security, sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'KALSHI')`);
    // A yes/no market, a three-way event, and a perp.
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES
      (1, 'T-YES', 0, 7), (2, 'T-NO', 0, 7), (3, 'M-A', 0, 8), (4, 'M-B', 0, 8), (5, 'M-C', 0, 8), (6, 'BTC-PERP', 0, 1)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, exchange_security_symbol)
      VALUES (500, 1, 1, 'KX-T:yes', 'T Yes'), (501, 1, 2, 'KX-T:no', 'T No'), (502, 1, 3, 'KX-M-A', 'M A'),
             (503, 1, 4, 'KX-M-B', 'M B'), (504, 1, 5, 'KX-M-C', 'M C'), (505, 1, 6, 'BTC', 'BTC perp')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id) VALUES
      (10, 'Will T happen?', 1, 'KX-T'), (20, 'Who wins M?', 1, 'KX-M')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label) VALUES
      (10, 1, 'Yes'), (10, 2, 'No'), (20, 3, 'A'), (20, 4, 'B'), (20, 5, 'C')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb')`);
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config) VALUES ('s', 1, 'STOPPED', 'paper', '{}')`);
  });

  async function hold(listingId: number, net: number, cost: number, realized = 0) {
    await client.query(`INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter,
        cum_qty_after, net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version, recorded_at)
      VALUES ('VENUE', 's', 1, $1::int, 'paper', $1::int, 1, $2, $3, $4, 0, 1, '2026-10-07T11:00:00Z')`,
    [listingId, net * UNIT, cost * CENT, realized * CENT]);
  }

  async function mark(listingId: number, mid: number) {
    await client.query(`INSERT INTO ledger.mark VALUES ($1, '2026-10-07T11:30:00Z', $2, $2, 0)`, [listingId, mid * CENT]);
  }

  it('values each outcome of a yes/no market and a three-way event, and leaves the perp out of both', async () => {
    await hold(500, 10, 400);
    await mark(500, 45);
    await hold(501, 4, 220);
    await mark(501, 54);
    await hold(502, 5, 150);
    await mark(502, 30);
    await hold(503, -2, 100);
    await mark(503, 50);
    await hold(505, 1, 10_000, 3);

    const result = await events(client, { strategyId: '1', mode: 'paper' }, now);
    const yesNo = result.events.find(e => e.eventId === 10)?.markets[0];
    // Now: YES up 10 x 5c, NO down 4 x 1c. If Yes: YES pays $10 on $4 cost, NO loses its $2.20.
    expect(yesNo?.current).toBe(cents(46));
    expect(yesNo?.scenarios).toEqual([
      { label: 'Yes', pnl: cents(380), change: cents(334) },
      { label: 'No', pnl: cents(-220), change: cents(-266) },
    ]);
    expect(yesNo?.netExposure).toEqual({ outcome: 'Yes', quantity: String(6 * UNIT) });
    expect([yesNo?.worst, yesNo?.best]).toEqual([cents(-220), cents(380)]);

    const threeWay = result.events.find(e => e.eventId === 20)?.markets[0];
    // Long 5 A at 30c, short 2 B at 50c, nothing on C.
    expect(threeWay?.scenarios.map(s => [s.label, s.pnl])).toEqual([
      ['A', cents(450)], ['B', cents(-250)], ['C', cents(-50)],
    ]);
    expect(threeWay?.outcomes.map(o => [o.outcome, o.held?.netQuantity ?? null])).toEqual([
      ['A', String(5 * UNIT)], ['B', String(-2 * UNIT)], ['C', null],
    ]);
    expect(result.other.map(o => [o.listingId, o.total])).toEqual([[505, cents(3)]]);
  });

  it('returns events still held by default, and pages the flat ones most recently resolved first', async () => {
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type) VALUES (7, 'L-YES', 0, 7)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id, exchange_security_symbol)
      VALUES (506, 1, 7, 'KX-L:yes', 'L Yes')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id, expiry) VALUES
      (30, 'Will L happen?', 1, 'KX-L', '2026-10-07T09:00:00Z')`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label) VALUES (30, 7, 'Yes')`);
    await client.query(`UPDATE sm.event SET resolved = true, resolved_at = '2026-10-06T10:00:00Z' WHERE event_id = 10`);
    await hold(502, 5, 150);
    await hold(500, 0, 0, 5);
    await hold(506, 0, 0, -2);
    await hold(505, 0, 0, 3);
    const params = { strategyId: '1', mode: 'paper' };

    const active = await events(client, params, now);
    expect(active.events.map(e => e.eventId)).toEqual([20]);
    expect(active.other).toEqual([]);
    expect([active.counts, active.nextBefore]).toEqual([{ active: 1, history: 2, flatOther: 1 }, null]);

    const history = (extra: Record<string, string>) => events(client, { ...params, status: 'history', ...extra }, now);
    const first = await history({ limit: '1' });
    expect(first.events.map(e => [e.eventId, e.markets[0].current])).toEqual([[30, cents(-2)]]);
    expect(first.other.map(o => [o.listingId, o.total])).toEqual([[505, cents(3)]]);
    const second = await history({ limit: '1', before: first.nextBefore as string });
    expect([second.events.map(e => e.eventId), second.other]).toEqual([[10], []]);
    const third = await history({ limit: '1', before: second.nextBefore as string });
    expect([third.events, third.nextBefore]).toEqual([[], null]);
    expect((await history({})).events.map(e => e.eventId)).toEqual([30, 10]);

    await expect(history({ before: '12' })).rejects.toThrow('before must be');
    await expect(history({ limit: '201' })).rejects.toThrow('limit must be 1 to 200');
    await expect(events(client, { ...params, status: 'open' }, now)).rejects.toThrow('status must be');
  });

  it('a strategy that has traded thousands of events answers with the ones it holds and a page of the rest', async () => {
    // 3,000 one-contract events, each traded once; 10 still held.
    await client.query(`INSERT INTO sm.security (security_id, symbol, type, contract_type)
      SELECT id, 'S' || id, 0, 7 FROM generate_series(1000, 3999) id`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id)
      SELECT id, 1, id, 'KX-' || id || ':yes' FROM generate_series(1000, 3999) id`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id, expiry)
      SELECT id, 'Event ' || id, 1, 'KX-' || id, '2026-09-01T00:00:00Z'::timestamptz + id * interval '1 minute'
      FROM generate_series(1000, 3999) id`);
    await client.query(`INSERT INTO sm.event_contract (event_id, security_id, outcome_label)
      SELECT id, id, 'Yes' FROM generate_series(1000, 3999) id`);
    await client.query(`INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter,
        cum_qty_after, net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version, recorded_at)
      SELECT 'VENUE', 's', 1, id, 'paper', id, 1, CASE WHEN id < 1010 THEN $1 ELSE 0 END,
        CASE WHEN id < 1010 THEN $2 ELSE 0 END, $3, 0, 1, '2026-10-01T00:00:00Z'
      FROM generate_series(1000, 3999) id`, [UNIT, 50 * CENT, CENT]);

    const started = Date.now();
    const active = await events(client, { strategyId: '1', mode: 'paper' }, now);
    const history = await events(client, { strategyId: '1', mode: 'paper', status: 'history' }, now);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect([active.events.length, active.counts]).toEqual([10, { active: 10, history: 2990, flatOther: 0 }]);
    expect([history.events.length, history.events[0].eventId, history.events[49].eventId]).toEqual([50, 3999, 3950]);
    expect(JSON.stringify(history).length).toBeLessThan(100_000);
    const next = await events(client, { strategyId: '1', mode: 'paper', status: 'history', before: history.nextBefore as string }, now);
    expect(next.events[0].eventId).toBe(3949);
  }, 60_000);

  it('collapses the outcomes it does not hold into one scenario, since they all pay the same', async () => {
    await hold(502, 5, 150);
    const threeWay = (await events(client, { strategyId: '1', mode: 'paper' }, now)).events[0].markets[0];
    expect(threeWay.scenarios.map(s => [s.label, s.pnl])).toEqual([['A', cents(350)], ['Any of the other 2 outcomes', cents(-150)]]);
  });

  it("values a session's scenarios as session PnL, leaving out what its inherited inventory was worth at the start", async () => {
    // Session s bought 10 YES at 40c and stopped; session t started at 12:00, inheriting them, valued at 50c then.
    await hold(500, 10, 400);
    await client.query(`UPDATE strategy.session SET started_at = '2026-10-07T10:00:00Z', stopped_at = '2026-10-07T11:45:00Z'`);
    await client.query(`INSERT INTO ledger.mark VALUES (500, '2026-10-07T11:30:00Z', $1, $1, 0), (500, '2026-10-07T12:30:00Z', $2, $2, 0)`,
      [50 * CENT, 45 * CENT]);
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
      VALUES ('t', 1, 'RUNNING', 'paper', '{}', '2026-10-07T12:00:00Z')`);
    await client.query(`INSERT INTO strategy.session_listing VALUES ('t', 1, 'paper', 500, true)`);

    const market = (await events(client, { sessionId: 't' }, new Date('2026-10-07T13:00:00Z'))).events[0].markets[0];
    // Now 45c: session PnL 10 x (45 - 50) = -50c. If Yes: 10 x (100 - 50) = +500c; if No: 10 x (0 - 50) = -500c.
    expect(market.current).toBe(cents(-50));
    expect(market.scenarios.map(x => [x.label, x.pnl])).toEqual([['Yes', cents(500)], ['No', cents(-500)]]);
    expect(market.outcomes[0].held?.total).toBe(cents(-50));
    await expect(events(client, {}, now)).rejects.toThrow(/strategyId or sessionId/);
  });
});
