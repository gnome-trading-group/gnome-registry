import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { ValidationError, withTransaction } from '../lambda/endpoints/base';
import { writeBatch } from '../lambda/endpoints/ledger-batch';
import { summarize } from '../lambda/endpoints/pnl-summary';
import { series } from '../lambda/endpoints/pnl-series';
import { attention } from '../lambda/endpoints/monitoring-attention';
import { EventContractHandler } from '../lambda/endpoints/event-contracts';
import { bookAdjustment, parseAdjustment } from '../lambda/endpoints/ledger-adjustments';
import { StrategySessionHandler } from '../lambda/endpoints/strategy-sessions';
import { formatPrice, sweepSettlements } from '../lambda/sync/settlement-sweeper';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const CENT = 10_000_000;
const UNIT = 1_000_000;
const DOLLAR = 100 * CENT;
const cents = (value: number) => String(value * CENT);

// A Kalshi binary: listing 500 trades YES (security 1, contract 1), listing 501 trades NO (security 2, contract 2).
// Listing 502 is a second market (security 3, contract 3) that never settles.
describeDb('Settlement sweeper, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  let counter = 0;

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    counter = 0;
    await client.query(`TRUNCATE ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.listing_spec, sm.listing,
      sm.event_contract, sm.event, sm.security, sm.exchange RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'KX-T-YES', 4), (2, 'KX-T-NO', 4),
      (3, 'KX-U-YES', 4)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id,
      exchange_security_symbol) VALUES (500, 1, 1, 'T:yes', 'T-YES'), (501, 1, 2, 'T:no', 'T-NO'),
      (502, 1, 3, 'U:yes', 'U-YES')`);
    await client.query(`INSERT INTO sm.event (event_id, title, exchange_id, native_event_id) VALUES (1, 'T?', 1, 'T'),
      (2, 'U?', 1, 'U')`);
    await client.query(`INSERT INTO sm.event_contract (event_contract_id, event_id, security_id, outcome_label)
      VALUES (1, 1, 1, 'Yes'), (2, 1, 2, 'No'), (3, 2, 3, 'Yes')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb')`);
  });

  async function session(id: string, listings: number[], mode = 'paper') {
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
      VALUES ($1, 1, 'RUNNING', $2, '{}', NOW() - INTERVAL '2 hours')`, [id, mode]);
    for (const listing of listings) {
      await client.query(`INSERT INTO strategy.session_listing VALUES ($1, 1, $2, $3, true)`, [id, mode, listing]);
    }
  }

  async function stop(id: string) {
    await client.query(`UPDATE strategy.session SET status = 'STOPPED', stopped_at = NOW() WHERE session_id = $1`, [id]);
  }

  // A session opening a position with one venue fill: side 0 buys, 1 sells.
  async function open(sessionId: string, listingId: number, side: 0 | 1, qty: number, priceCents: number, fee = 0) {
    counter++;
    const net = (side === 0 ? 1 : -1) * qty * UNIT;
    const body = JSON.stringify({ sessionId, fills: [{
      source: 'VENUE', listingId, eventTimeNs: 1, clientOidCounter: counter, cumQtyAfter: qty * UNIT, side,
      fillQty: qty * UNIT, fillPrice: priceCents * CENT, fee, netQuantityAfter: net,
      totalCostAfter: qty * priceCents * CENT, realizedPnlAfter: 0, feesAfter: fee, positionVersion: 1,
    }] });
    await withTransaction(client, (c) => writeBatch(c, sessionId, body));
    await client.query(`UPDATE ledger.fill SET recorded_at = NOW() - INTERVAL '1 hour' WHERE fill_id =
      (SELECT MAX(fill_id) FROM ledger.fill)`);
  }

  async function settle(items: { eventContractId: number; settlementPrice: number | string }[]) {
    const handler = new EventContractHandler();
    handler.client = client;
    return handler.modifyMany(JSON.stringify(items));
  }

  const settlementRows = async () => (await client.query(`SELECT strategy_id, listing_id, mode, side, fill_qty,
    fill_price, fee, net_quantity_after, total_cost_after, realized_pnl_after, fees_after, position_version, actor,
    reason, session_id FROM ledger.fill WHERE source = 'SETTLEMENT' ORDER BY fill_id`)).rows;

  const position = async (listingId: number, mode = 'paper') => (await client.query(`SELECT net_quantity,
    total_cost, version, session_id FROM ledger.position WHERE listing_id = $1 AND mode = $2`, [listingId, mode])).rows[0];

  it.each([
    ['a long that wins', 500, 0, 40, DOLLAR, 10 * (100 - 40)],
    ['a long that loses', 500, 0, 40, 0, -10 * 40],
    ['a short that wins', 500, 1, 40, 0, 10 * 40],
    ['a short that loses', 500, 1, 40, DOLLAR, -10 * (100 - 40)],
    ['a long on the NO side settling at a fractional value', 501, 0, 30, 47 * CENT, 10 * (47 - 30)],
  ] as const)('closes %s at the settlement price and realizes the difference from its entry',
    async (_name, listingId, side, entryCents, price, realizedCents) => {
      await session('s', [listingId]);
      await open('s', listingId, side, 10, entryCents);
      await stop('s');
      await settle([{ eventContractId: listingId === 500 ? 1 : 2, settlementPrice: price }]);

      expect(await sweepSettlements(client)).toEqual({ booked: 1, skipped: 0, failed: 0, ordersExpired: 0 });
      expect(await settlementRows()).toEqual([{
        strategy_id: 1, listing_id: listingId, mode: 'paper', side: side === 0 ? 1 : 0, fill_qty: String(10 * UNIT),
        fill_price: String(price), fee: '0', net_quantity_after: '0', total_cost_after: '0',
        realized_pnl_after: cents(realizedCents), fees_after: '0', position_version: '2', actor: 'settlement-sweeper',
        reason: `market settled at ${formatPrice(BigInt(price))}`, session_id: null,
      }]);
      expect(await position(listingId)).toEqual({ net_quantity: '0', total_cost: '0', version: '2', session_id: null });
    });

  it('counts the settlement in the strategy\'s lifetime PnL and charts it as its own event', async () => {
    await session('s', [500]);
    await open('s', 500, 0, 10, 40, CENT);
    await stop('s');
    await settle([{ eventContractId: 1, settlementPrice: DOLLAR }]);
    await sweepSettlements(client);

    const now = new Date(Date.now() + 60_000);
    const strategy = await summarize(client, { strategyId: '1', mode: 'paper' }, now) as any;
    expect([strategy.totals.lifetime, strategy.totals.realized, strategy.totals.unrealized, strategy.totals.fees])
      .toEqual([cents(599), cents(600), cents(0), cents(1)]);
    expect(strategy.openPositions).toBe(0);

    const s = await series(client, {
      strategyId: '1', mode: 'paper', start: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      resolution: String(30 * 60_000),
    }, now) as any;
    const event = s.events.find((e: any) => e.kind === 'SETTLEMENT');
    expect([event.pnlImpact, event.actor]).toEqual([cents(600), 'settlement-sweeper']);
  });

  it('leaves a position a running session holds, then books it once that session stops', async () => {
    await session('s', [500]);
    await open('s', 500, 0, 10, 40);
    await settle([{ eventContractId: 1, settlementPrice: DOLLAR }]);

    expect((await sweepSettlements(client)).booked).toBe(0);
    expect(await position(500)).toMatchObject({ net_quantity: String(10 * UNIT), version: '1' });

    await stop('s');
    expect((await sweepSettlements(client)).booked).toBe(1);
    expect(await position(500)).toMatchObject({ net_quantity: '0', version: '2' });
  });

  it('books each position once, however often it runs, in paper and live alike', async () => {
    await session('p', [500], 'paper');
    await open('p', 500, 0, 10, 40);
    await stop('p');
    await session('l', [500], 'live');
    await open('l', 500, 1, 5, 60);
    await stop('l');
    await settle([{ eventContractId: 1, settlementPrice: DOLLAR }]);

    expect((await sweepSettlements(client)).booked).toBe(2);
    expect((await sweepSettlements(client)).booked).toBe(0);
    const rows = await settlementRows();
    expect(rows.map(r => [r.mode, r.realized_pnl_after])).toEqual([['live', cents(-5 * 40)], ['paper', cents(600)]]);
  });

  it('leaves a position under review to an operator, and ignores markets that have not settled', async () => {
    await session('s', [500, 502]);
    await open('s', 500, 0, 10, 40);
    await open('s', 502, 0, 10, 40);
    await stop('s');
    await client.query(`UPDATE ledger.position SET needs_review = TRUE WHERE listing_id = 500`);
    await settle([{ eventContractId: 1, settlementPrice: DOLLAR }]);

    expect((await sweepSettlements(client)).booked).toBe(0);
    expect(await settlementRows()).toEqual([]);
  });

  it('expires the orders an ended session left on a settled market, never a running session\'s', async () => {
    await session('old', [500]);
    await stop('old');
    await session('live', [501], 'live');
    await client.query(`INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id,
      mode, side, price, size) VALUES ('old', 1, 1, 500, 1, 'paper', 0, 400000000, 10000000),
      ('live', 1, 1, 501, 1, 'live', 0, 400000000, 10000000)`);
    await settle([{ eventContractId: 1, settlementPrice: DOLLAR }, { eventContractId: 2, settlementPrice: 0 }]);

    expect((await sweepSettlements(client)).ordersExpired).toBe(1);
    const orders = (await client.query(`SELECT session_id, status, close_state, closed_at IS NOT NULL AS closed
      FROM ledger.order ORDER BY session_id`)).rows;
    expect(orders).toEqual([
      { session_id: 'live', status: 'OPEN', close_state: null, closed: false },
      { session_id: 'old', status: 'CLOSED', close_state: 'EXPIRED', closed: true },
    ]);
  });

  it('records a settlement value once: a repeat is a no-op, a different value is refused, garbage is refused', async () => {
    expect((await settle([{ eventContractId: 1, settlementPrice: DOLLAR }, { eventContractId: 2, settlementPrice: 0 }]))
      .statusCode).toBe(200);
    expect((await settle([{ eventContractId: 1, settlementPrice: 0 }])).statusCode).toBe(200);
    const contracts = (await client.query(`SELECT event_contract_id, settlement_price, settled_at IS NOT NULL AS settled
      FROM sm.event_contract ORDER BY event_contract_id`)).rows;
    expect(contracts).toEqual([
      { event_contract_id: 1, settlement_price: String(DOLLAR), settled: true },
      { event_contract_id: 2, settlement_price: '0', settled: true },
      { event_contract_id: 3, settlement_price: null, settled: false },
    ]);

    await expect(client.query(`UPDATE sm.event_contract SET settlement_price = 0 WHERE event_contract_id = 1`))
      .rejects.toThrow(/already settled/);
    await expect(settle([{ eventContractId: 3, settlementPrice: '1; DROP TABLE x' }])).rejects.toThrow(ValidationError);
    await expect(settle([{ eventContractId: 3, settlementPrice: 2 * DOLLAR }])).rejects.toThrow(ValidationError);
    await expect(client.query(`INSERT INTO sm.event_contract (event_contract_id, event_id, security_id, outcome_label) VALUES (4, 2, 1, 'Dup')`))
      .rejects.toThrow(/uq_event_contract_security/);

    const handler = new EventContractHandler();
    handler.client = client;
    const listed = JSON.parse((await handler.get({ eventContractId: '1' })).body);
    expect([listed[0].settlement_price, listed[0].settled_at !== null]).toEqual([String(DOLLAR), true]);
  });

  it('never lets an operator book a settlement by hand: the adjustments endpoint only books MANUAL trades', async () => {
    const adjustment = parseAdjustment(JSON.stringify({ strategyId: 1, listingId: 500, mode: 'paper', reason: 'x',
      source: 'SETTLEMENT', trade: { side: 0, qty: UNIT, price: 40 * CENT } }));
    await withTransaction(client, (c) => bookAdjustment(c, adjustment, 'ops@example.com'));
    expect((await client.query(`SELECT source FROM ledger.fill`)).rows).toEqual([{ source: 'MANUAL' }]);
  });

  it('refuses to start a session on a settled listing', async () => {
    await settle([{ eventContractId: 1, settlementPrice: DOLLAR }]);
    const handler = new StrategySessionHandler();
    handler.client = client;
    const create = (sessionId: string, listings: number[]) => handler.createOne(JSON.stringify({
      sessionId, strategyId: 1, status: 'SUBMITTED', mode: 'paper', config: { listings },
    }));
    const refused = await create('n1', [502, 500]);
    expect([refused.statusCode, JSON.parse(refused.body).message]).toEqual([409, expect.stringMatching(/500 has settled/)]);
    expect((await client.query(`SELECT count(*)::int AS n FROM strategy.session`)).rows[0].n).toBe(0);
    expect((await create('n2', [502])).statusCode).toBe(200);
  });

  it('flags a finished market that never got a value, and a settled position that is still open', async () => {
    await session('s', [500, 502]);
    await open('s', 500, 0, 10, 40);
    await open('s', 502, 0, 10, 40);
    await client.query(`UPDATE sm.listing SET active = FALSE, date_modified = NOW() - INTERVAL '2 days'
      WHERE listing_id = 502`);
    await settle([{ eventContractId: 1, settlementPrice: DOLLAR }]);

    const items = (await attention(client, 'paper', new Date())).filter(i => i.kind.startsWith('SETTLEMENT'));
    expect(items.map(i => [i.kind, i.listingId, i.detail])).toEqual([
      ['SETTLEMENT_PENDING', 502, expect.stringMatching(/never recorded/)],
      ['SETTLEMENT_BLOCKED', 500, expect.stringMatching(/session still holds/)],
    ]);
  });
});
