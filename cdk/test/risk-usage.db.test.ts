import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { riskUsage } from '../lambda/endpoints/risk-usage';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const CENT = 10_000_000;
const UNIT = 1_000_000;
const now = new Date('2026-10-07T12:00:00Z');

describeDb('risk limit usage against Postgres', () => {
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
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.listing_spec, sm.listing, sm.security,
      sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'X', 0)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_symbol)
      VALUES (500, 1, 1, 'KX-A'), (501, 1, 1, 'KX-B'), (502, 1, 1, 'KX-C')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb'), ('mm')`);
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
      VALUES ('s', 1, 'RUNNING', 'paper', '{}', '2026-10-07T10:00:00Z')`);
    await client.query(`INSERT INTO strategy.session_listing VALUES ('s', 1, 'paper', 500, true), ('s', 1, 'paper', 501, true)`);
  });

  async function policy(type: string, parameters: object, target: { strategyId?: number; listingId?: number } = { strategyId: 1 }, enabled = true) {
    await client.query(`INSERT INTO risk.policy (policy_type, strategy_id, listing_id, parameters, enabled) VALUES ($1, $2, $3, $4, $5)`,
      [type, target.strategyId ?? null, target.listingId ?? null, JSON.stringify(parameters), enabled]);
  }

  it("measures each limit as the session's OMS does, closest first, leaving out what does not apply", async () => {
    // Bought 5 of KX-A at 40c (fee 1c), now marked at 30c: down 51c.
    await client.query(`INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter,
        cum_qty_after, side, fill_qty, fill_price, fee, net_quantity_after, total_cost_after, realized_pnl_after,
        fees_after, position_version, recorded_at)
      VALUES ('VENUE', 's', 1, 500, 'paper', 1, $1, 0, $1, $2, $3, $1, $4, 0, $3, 1, '2026-10-07T11:00:00Z'),
             ('VENUE', 's', 1, 500, 'paper', 2, $5, 0, $5, $2, 0, $1, $4, 0, $3, 1, '2026-10-07T11:00:00Z')`,
    [5 * UNIT, 40 * CENT, CENT, 200 * CENT, 1 * UNIT]);
    await client.query(`INSERT INTO ledger.mark VALUES (500, '2026-10-07T11:30:00Z', $1, $1, 0)`, [30 * CENT]);
    // Working: a buy of 4 on KX-A with 1 already filled (3 left), and a sell of 2 on KX-B.
    await client.query(`INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id, mode,
        side, price, size, status) VALUES ('s', 2, 1, 500, 1, 'paper', 0, $1, $2, 'OPEN'), ('s', 3, 1, 501, 1, 'paper', 1, $1, $3, 'OPEN')`,
    [40 * CENT, 4 * UNIT, 2 * UNIT]);

    await policy('MAX_POSITION', { maxPosition: 10 * UNIT });
    await policy('MAX_OPEN_ORDERS', { maxOpenOrders: 2 });
    await policy('MAX_OPEN_ORDERS', { maxOpenOrders: 4 }, { strategyId: 1, listingId: 501 });
    await policy('MAX_TOTAL_PNL_LOSS', { maxLoss: 100 * CENT }, {});
    await policy('MAX_ORDER_SIZE', { maxOrderSize: 50 * UNIT });
    await policy('MAX_POSITION', { maxPosition: UNIT }, { strategyId: 2 });
    await policy('MAX_POSITION', { maxPosition: UNIT }, { listingId: 502 });
    await policy('MAX_POSITION', { maxPosition: UNIT }, { strategyId: 1, listingId: 501 }, false);

    const usage = await riskUsage(client, 's', now);
    expect(usage?.policies.map(p => [p.policyType, p.level, p.value, p.limit, p.usage, p.bindingSymbol])).toEqual([
      ['MAX_OPEN_ORDERS', 'strategy', '2', '2', 1, null],
      // KX-A: 5 held + 3 more if the open buy fills.
      ['MAX_POSITION', 'strategy', String(8 * UNIT), String(10 * UNIT), 0.8, 'KX-A'],
      ['MAX_TOTAL_PNL_LOSS', 'global', String(51 * CENT), String(100 * CENT), 0.51, null],
      ['MAX_OPEN_ORDERS', 'strategy', '1', '4', 0.25, null],
      ['MAX_ORDER_SIZE', 'strategy', null, String(50 * UNIT), null, null],
    ]);
    expect(await riskUsage(client, 'ghost', now)).toBeNull();
  });
});
