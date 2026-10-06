import { Pool, PoolClient } from 'pg';
import { withTransaction } from '../lambda/endpoints/base';
import { writeBatch } from '../lambda/endpoints/ledger-batch';
import { StrategySessionHandler } from '../lambda/endpoints/strategy-sessions';
import { generateHaltUpsertQuery } from '../lambda/endpoints/risk-halts';
import { buildOrdersQuery } from '../lambda/endpoints/ledger-orders';

// Runs the ledger's SQL against a real Postgres with every migration applied. Set LEDGER_TEST_DB to its connection
// string (a throwaway database: each test resets the tables it uses).
const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

describeDb('ledger batch against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE ledger.fill, ledger.position, ledger.order, ledger.mark, strategy.session_listing,
      risk.policy, risk.policy_history, strategy.session, strategy.strategy, sm.listing, sm.security, sm.exchange
      RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, schema_type, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'mbp-10', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'X', 0)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id) VALUES (500, 1, 1), (501, 1, 1)`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb')`);
    await session('s1', [500]);
  });

  async function session(id: string, listings: number[], status = 'RUNNING') {
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config)
      VALUES ($1, 1, $2, 'paper', '{}')`, [id, status]);
    for (const listing of listings) {
      await client.query(`INSERT INTO strategy.session_listing VALUES ($1, 1, 'paper', $2, true)`, [id, listing]);
    }
  }

  async function post(sessionId: string, events: Record<string, unknown>) {
    const body = JSON.stringify({ sessionId, ...events });
    await withTransaction(client, (c) => writeBatch(c, sessionId, body));
  }

  function fill(counter: number, cum: number, net: number, version: number, extra: Record<string, unknown> = {}) {
    return {
      source: 'VENUE', listingId: 500, clientOidCounter: counter, cumQtyAfter: cum, side: 0, fillQty: cum,
      fillPrice: 400_000_000, fee: 1_000_000, eventTimeNs: 1, netQuantityAfter: net, totalCostAfter: net * 400,
      realizedPnlAfter: 0, feesAfter: version * 1_000_000, positionVersion: version, ...extra,
    };
  }

  async function position() {
    const result = await client.query('SELECT net_quantity, version, needs_review FROM ledger.position');
    return result.rows[0];
  }

  it('books fills and takes the position from the newest one', async () => {
    await post('s1', { fills: [fill(1, 1_000_000, 1_000_000, 1), fill(1, 2_000_000, 2_000_000, 2)] });
    expect(await position()).toEqual({ net_quantity: '2000000', version: '2', needs_review: false });
  });

  it('replaying a batch books nothing twice', async () => {
    const events = { fills: [fill(1, 1_000_000, 1_000_000, 1)] };
    await post('s1', events);
    await post('s1', events);
    const count = await client.query('SELECT count(*)::int AS n FROM ledger.fill');
    expect(count.rows[0].n).toBe(1);
  });

  it('a late batch never rolls a position back', async () => {
    await post('s1', { fills: [fill(2, 1_000_000, 3_000_000, 5)] });
    await post('s1', { fills: [fill(1, 1_000_000, 1_000_000, 4)] });
    expect((await position()).version).toBe('5');
  });

  it('fences a session without a lease on the listing, and a stopped session', async () => {
    await expect(post('s1', { fills: [fill(1, 1, 1, 1, { listingId: 501 })] })).rejects.toThrow(/no lease/);
    await client.query(`UPDATE strategy.session SET status = 'STOPPED' WHERE session_id = 's1'`);
    await expect(post('s1', { fills: [fill(1, 1, 1, 1)] })).rejects.toThrow(/STOPPED/);
  });

  it('keeps accepting writes while STOPPING, then fences once STOPPED releases the lease', async () => {
    await client.query(`UPDATE strategy.session SET status = 'STOPPING' WHERE session_id = 's1'`);
    await post('s1', { fills: [fill(1, 1_000_000, 1_000_000, 1)] });
    await client.query(`UPDATE strategy.session SET status = 'STOPPED' WHERE session_id = 's1'`);
    await expect(post('s1', { fills: [fill(1, 2_000_000, 2_000_000, 2)] })).rejects.toThrow(/STOPPED/);
    expect((await position()).net_quantity).toBe('1000000');
  });

  it('a gap marks the position for review', async () => {
    await post('s1', { fills: [fill(1, 1_000_000, 1_000_000, 1), { ...fill(0, 0, 1_000_000, 1), source: 'GAP' }] });
    expect((await position()).needs_review).toBe(true);
  });

  it('order events land correctly in any order across batches', async () => {
    const order = { clientOidCounter: 9, listingId: 500, exchangeId: 1 };
    await post('s1', { orderCloses: [{ ...order, filledQty: 5 }] });
    await post('s1', { orderAcks: [{ ...order, exchangeOrderId: 'k-9' }] });
    await post('s1', { orderOpens: [{ ...order, side: 0, price: 1, size: 5 }] });
    const row = (await client.query('SELECT status, exchange_order_id, size, filled_qty FROM ledger.order')).rows[0];
    expect(row).toEqual({ status: 'CLOSED', exchange_order_id: 'k-9', size: '5', filled_qty: '5' });
  });

  it('a recovery fill must come from an earlier session of the same strategy', async () => {
    await session('old', [], 'STOPPED');
    await post('s1', { fills: [fill(1, 1_000_000, 1_000_000, 1, { source: 'RECOVERY', originSessionId: 'old' })] });
    await expect(post('s1', {
      fills: [fill(2, 1_000_000, 1_000_000, 2, { source: 'RECOVERY', originSessionId: 'nope' })],
    })).rejects.toThrow(/origin session/);
  });

  it('stores marks once per listing and time', async () => {
    const mark = { listingId: 500, tsMs: 1_700_000_000_000, bid: 1, ask: 3, lastTrade: 2 };
    await post('s1', { marks: [mark, mark] });
    const count = await client.query('SELECT count(*)::int AS n FROM ledger.mark');
    expect(count.rows[0].n).toBe(1);
  });

  it('creating a session takes its leases, and an overlapping session of the strategy gets a 409 naming the holder', async () => {
    const handler = new StrategySessionHandler();
    handler.client = client;
    const create = (sessionId: string, listings: number[]) => handler.createOne(JSON.stringify({
      sessionId, strategyId: 1, status: 'SUBMITTED', mode: 'paper', config: { listings },
    }));
    expect((await create('n1', [501])).statusCode).toBe(200);
    const clash = await create('n2', [501]);
    expect(clash.statusCode).toBe(409);
    expect(JSON.parse(clash.body).conflictingSessionId).toBe('n1');
    expect((await client.query(`SELECT count(*)::int AS n FROM strategy.session WHERE session_id = 'n2'`)).rows[0].n).toBe(0);
    expect((await create('n3', [])).statusCode).toBe(400);
  });

  it('a strategy-on-listing halt is its own kill, separate from the strategy-wide one, and repeats are idempotent', async () => {
    const onListing = await client.query(generateHaltUpsertQuery({ strategyId: 1, listingId: 500 }));
    const again = await client.query(generateHaltUpsertQuery({ strategyId: 1, listingId: 500 }));
    const wide = await client.query(generateHaltUpsertQuery({ strategyId: 1 }));
    expect(again.rows[0].policy_id).toBe(onListing.rows[0].policy_id);
    expect(wide.rows[0].policy_id).not.toBe(onListing.rows[0].policy_id);
    const rows = await client.query(`SELECT strategy_id, listing_id FROM risk.policy WHERE policy_type = 'KILL_SWITCH' ORDER BY policy_id`);
    expect(rows.rows).toEqual([{ strategy_id: 1, listing_id: 500 }, { strategy_id: 1, listing_id: null }]);
  });

  it('a starting session settles an ended session\'s order, never a running one\'s, and sees what it already filled', async () => {
    await session('old', [], 'STOPPED');
    await client.query(`INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id,
      mode, side, price, size) VALUES ('old', 3, 1, 500, 1, 'paper', 0, 400000000, 10000000)`);
    await post('s1', { fills: [fill(3, 4_000_000, 4_000_000, 1, {
      source: 'RECOVERY', originSessionId: 'old', fillQty: 4_000_000, fillPrice: 400_000_000, fee: 20_000_000,
    })] });

    const seen = (await client.query(buildOrdersQuery({ mode: 'paper', listingIds: '500' }))).rows[0];
    expect([seen.ledger_filled_qty, seen.ledger_filled_notional, seen.ledger_fees])
      .toEqual(['4000000', '1600000000', '20000000']);

    await session('live-one', [501]);
    await client.query(`INSERT INTO ledger.order (session_id, client_oid_counter, strategy_id, listing_id, exchange_id,
      mode) VALUES ('live-one', 9, 1, 500, 1, 'paper')`);
    await post('s1', { orderRecoveries: [
      { originSessionId: 'old', clientOidCounter: 3, listingId: 500 },
      { originSessionId: 'live-one', clientOidCounter: 9, listingId: 500 },
    ] });

    const statuses = await client.query('SELECT session_id, status FROM ledger.order ORDER BY session_id');
    expect(statuses.rows).toEqual([
      { session_id: 'live-one', status: 'OPEN' },
      { session_id: 'old', status: 'RECOVERED' },
    ]);
  });

  it('orders acknowledged without a venue id, as in paper, don\'t collide', async () => {
    const acks = [1, 2].map(counter => ({ clientOidCounter: counter, listingId: 500, exchangeId: 1, exchangeOrderId: '' }));
    await post('s1', { orderAcks: acks });
    const rows = await client.query('SELECT exchange_order_id FROM ledger.order ORDER BY client_oid_counter');
    expect(rows.rows).toEqual([{ exchange_order_id: null }, { exchange_order_id: null }]);
  });
});
