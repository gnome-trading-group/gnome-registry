import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { withTransaction } from '../lambda/endpoints/base';
import { writeBatch } from '../lambda/endpoints/ledger-batch';
import { StrategySessionHandler } from '../lambda/endpoints/strategy-sessions';
import { generateHaltUpsertQuery } from '../lambda/endpoints/risk-halts';
import { buildOrdersQuery } from '../lambda/endpoints/ledger-orders';
import { buildFillsQuery, withSlippage } from '../lambda/endpoints/ledger-fills';
import { buildOrderListQuery } from '../lambda/endpoints/ledger-order-list';
import { recordHeartbeat } from '../lambda/endpoints/strategy-session-heartbeat';

// Runs the ledger's SQL against a real Postgres with every migration applied. Set LEDGER_TEST_DB to its connection
// string (a throwaway database: each test resets the tables it uses).
const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;

describeDb('ledger batch against Postgres', () => {
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

  it('fills say whether they made or took, and closed orders how they ended', async () => {
    await post('s1', {
      fills: [fill(1, 1_000_000, 1_000_000, 1, { liquidity: 'MAKER' })],
      orderCloses: [
        { clientOidCounter: 1, listingId: 500, exchangeId: 1, filledQty: 1_000_000, state: 'FILLED', rejectReason: null },
        { clientOidCounter: 2, listingId: 500, exchangeId: 1, filledQty: 0, state: 'REJECTED',
          rejectReason: 'POST_ONLY_WOULD_CROSS' },
      ],
    });
    expect((await client.query('SELECT liquidity FROM ledger.fill')).rows).toEqual([{ liquidity: 'MAKER' }]);
    const orders = await client.query('SELECT close_state, reject_reason FROM ledger.order ORDER BY client_oid_counter');
    expect(orders.rows).toEqual([
      { close_state: 'FILLED', reject_reason: null },
      { close_state: 'REJECTED', reject_reason: 'POST_ONLY_WOULD_CROSS' },
    ]);
  });

  it('refusal counts only ever rise, and one on a listing the session does not trade never fences it', async () => {
    await post('s1', { rejectCounts: [{ listingId: 500, reason: 'HALTED', count: 5 }] });
    await post('s1', { rejectCounts: [{ listingId: 500, reason: 'HALTED', count: 3 }, { listingId: 999, reason: 'INVALID_PRICE', count: 1 }] });
    const counts = await client.query('SELECT listing_id, reason, count FROM ledger.reject_count ORDER BY listing_id');
    expect(counts.rows).toEqual([
      { listing_id: 500, reason: 'HALTED', count: '5' },
      { listing_id: 999, reason: 'INVALID_PRICE', count: '1' },
    ]);
  });

  it('a heartbeat is kept while the session runs, refused once it ended, and names unknown sessions', async () => {
    const body = JSON.stringify({ sessionId: 's1', uptimeMs: 5000, agents: [{ name: 'OmsAgent', stalledMs: 0 }] });
    expect(await recordHeartbeat(client, 's1', body)).toBe(200);
    const row = (await client.query(`SELECT health, last_heartbeat_at IS NOT NULL AS beat FROM strategy.session
      WHERE session_id = 's1'`)).rows[0];
    expect(row).toEqual({ health: { uptimeMs: 5000, agents: [{ name: 'OmsAgent', stalledMs: 0 }] }, beat: true });
    await client.query(`UPDATE strategy.session SET status = 'STOPPED' WHERE session_id = 's1'`);
    expect(await recordHeartbeat(client, 's1', body)).toBe(409);
    expect(await recordHeartbeat(client, 'ghost', body)).toBe(404);
  });

  it('pages through fills newest first without skipping or repeating, and polls for newer ones', async () => {
    await post('s1', { fills: [1, 2, 3, 4, 5].map(n => fill(n, 1_000_000, n * 1_000_000, n)) });
    const page = async (params: Record<string, string>) =>
      (await client.query(buildFillsQuery({ sessionId: 's1', limit: '2', ...params }))).rows
        .sort((a, b) => Number(b.fill_id) - Number(a.fill_id))
        .map(r => Number(r.client_oid_counter));
    expect(await page({})).toEqual([5, 4]);
    expect(await page({ before: '4' })).toEqual([3, 2]);
    expect(await page({ before: '2' })).toEqual([1]);
    expect(await page({ after: '2' })).toEqual([4, 3]);
    await expect(async () => buildFillsQuery({ sessionId: 's1', before: '1', after: '2' })).rejects.toThrow(/combined/);
  });

  it('values each fill against the mark when it traded: a buy below the mark is positive slippage', async () => {
    await client.query(`INSERT INTO ledger.mark (listing_id, ts, bid, ask, last_trade)
      VALUES (500, NOW() - INTERVAL '1 minute', 390000000, 430000000, 0)`);
    await post('s1', { fills: [fill(1, 2_000_000, 2_000_000, 1)] });
    const row = withSlippage((await client.query(buildFillsQuery({ sessionId: 's1' }))).rows[0]);
    // Bought 2 at 40c against a 41c mid: 2c better.
    expect([row.mark_price, row.slippage]).toEqual(['410000000', '20000000']);
  });

  it('lists orders with what filled, filtered to open or closed', async () => {
    await post('s1', {
      orderOpens: [1, 2].map(n => ({ clientOidCounter: n, listingId: 500, exchangeId: 1, side: 0, price: 400_000_000, size: 4_000_000 })),
      fills: [fill(1, 1_000_000, 1_000_000, 1), { ...fill(1, 3_000_000, 3_000_000, 2), fillQty: 2_000_000, fillPrice: 430_000_000 }],
      orderCloses: [{ clientOidCounter: 1, listingId: 500, exchangeId: 1, filledQty: 3_000_000, state: 'CANCELED' }],
    });
    const list = async (status: string) =>
      (await client.query(buildOrderListQuery({ sessionId: 's1', status }))).rows;
    const [closed] = await list('CLOSED');
    // 1 at 40c and 2 at 43c average 42c.
    expect([closed.client_oid_counter, closed.fills, closed.fill_qty, closed.avg_fill_price, closed.close_state])
      .toEqual(['1', '2', '3000000', '420000000', 'CANCELED']);
    expect((await list('OPEN')).map(r => r.client_oid_counter)).toEqual(['2']);
    expect(await list('ANY')).toHaveLength(2);
  });

  it('reads one order\'s fills, oldest first, with those a later session recovered for it', async () => {
    await session('old', [], 'STOPPED');
    await client.query(`INSERT INTO ledger.fill (source, session_id, strategy_id, listing_id, mode, client_oid_counter,
        cum_qty_after, fill_qty, fill_price, net_quantity_after, total_cost_after, position_version)
      VALUES ('VENUE', 'old', 1, 500, 'paper', 3, 1000000, 1000000, 400000000, 1000000, 400000000, 1),
             ('VENUE', 'old', 1, 500, 'paper', 4, 1000000, 1000000, 400000000, 2000000, 800000000, 2)`);
    await post('s1', { fills: [fill(3, 3_000_000, 4_000_000, 3, { source: 'RECOVERY', originSessionId: 'old', fillQty: 2_000_000 })] });
    const rows = (await client.query(buildFillsQuery({ orderSessionId: 'old', clientOidCounter: '3' }))).rows;
    expect(rows.map(r => [r.source, r.session_id, r.cum_qty_after])).toEqual([
      ['VENUE', 'old', '1000000'],
      ['RECOVERY', 's1', '3000000'],
    ]);
    expect(() => buildFillsQuery({ orderSessionId: 'old' })).toThrow(/clientOidCounter/);
  });
});
