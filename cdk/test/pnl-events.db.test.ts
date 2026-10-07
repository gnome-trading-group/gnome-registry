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
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI')`);
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

  it('collapses the outcomes it does not hold into one scenario, since they all pay the same', async () => {
    await hold(502, 5, 150);
    const threeWay = (await events(client, { strategyId: '1', mode: 'paper' }, now)).events[0].markets[0];
    expect(threeWay.scenarios.map(s => [s.label, s.pnl])).toEqual([['A', cents(350)], ['Any of the other 2 outcomes', cents(-150)]]);
  });
});
