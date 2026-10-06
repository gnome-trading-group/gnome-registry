import { Pool, PoolClient } from 'pg';
import { withTransaction } from '../lambda/endpoints/base';
import { writeBatch } from '../lambda/endpoints/ledger-batch';
import { sessionSeries } from '../lambda/endpoints/pnl-series';
import { sessionRows, strategyRows } from '../lambda/endpoints/pnl-latest';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const CENT = 10_000_000;
const UNIT = 1_000_000;

describeDb('PnL derived from the ledger, against Postgres', () => {
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
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id) VALUES (500, 1, 1)`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('arb')`);
  });

  async function session(id: string, startedAt: string) {
    await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
      VALUES ($1, 1, 'RUNNING', 'paper', '{}', $2)`, [id, startedAt]);
    await client.query(`INSERT INTO strategy.session_listing VALUES ($1, 1, 'paper', 500, true)`, [id]);
  }

  async function post(sessionId: string, events: Record<string, unknown>, at: string) {
    const body = JSON.stringify({ sessionId, ...events });
    await withTransaction(client, (c) => writeBatch(c, sessionId, body));
    await client.query(`UPDATE ledger.fill SET recorded_at = $2 WHERE session_id = $1 AND recorded_at > NOW() - INTERVAL '1 minute'`,
      [sessionId, at]);
  }

  it('a relaunched session starts from the inventory it inherited, then moves with its fills and marks', async () => {
    await session('old', '2026-10-06T10:00:00Z');
    // The old session bought 10 at 40c and realized nothing.
    await post('old', { fills: [{ source: 'VENUE', listingId: 500, clientOidCounter: 1, cumQtyAfter: 10 * UNIT,
      side: 0, fillQty: 10 * UNIT, fillPrice: 40 * CENT, fee: 0, eventTimeNs: 1, netQuantityAfter: 10 * UNIT,
      totalCostAfter: 400 * CENT, realizedPnlAfter: 0, feesAfter: 0, positionVersion: 1 }] }, '2026-10-06T10:01:00Z');
    await client.query(`UPDATE strategy.session SET status = 'STOPPED' WHERE session_id = 'old'`);

    await session('new', '2026-10-06T11:00:00Z');
    await post('new', { marks: [{ listingId: 500, tsMs: Date.parse('2026-10-06T11:00:30Z'), bid: 30 * CENT, ask: 32 * CENT, lastTrade: 0 }] },
      '2026-10-06T11:00:30Z');
    // The new session sells the 10 at 35c: realizes -$0.50 and goes flat.
    await post('new', { fills: [{ source: 'VENUE', listingId: 500, clientOidCounter: 1, cumQtyAfter: 10 * UNIT,
      side: 1, fillQty: 10 * UNIT, fillPrice: 35 * CENT, fee: CENT, eventTimeNs: 1, netQuantityAfter: 0,
      totalCostAfter: 0, realizedPnlAfter: -50 * CENT, feesAfter: CENT, positionVersion: 2 }] }, '2026-10-06T11:02:00Z');

    const latestNew = await sessionRows(client, 'new');
    expect(latestNew.map(r => [r.net_quantity, r.realized_pnl, r.total_fees])).toEqual([['0', String(-50 * CENT), String(CENT)]]);
    const latestOld = await sessionRows(client, 'old');
    expect(latestOld.map(r => [r.net_quantity, r.realized_pnl])).toEqual([[String(10 * UNIT), '0']]);
    // The strategy as a whole: flat now, with each session's realized PnL and fees summed.
    const strategy = await strategyRows(client, 1, ['paper']);
    expect(strategy.map(r => [r.net_quantity, r.realized_pnl, r.total_fees])).toEqual([['0', String(-50 * CENT), String(CENT)]]);

    const series = await sessionSeries(client, 'new', new Date('2026-10-06T11:00:00Z'), new Date('2026-10-06T11:05:00Z'));
    const ordered = [...series].reverse().map(r => ({ time: r.snapshot_time, net: r.net_quantity, total: r.total_pnl }));
    expect(ordered).toEqual([
      // Opens holding the inherited 10 with no mark yet: valued at entry.
      { time: '2026-10-06T11:00:00.000Z', net: String(10 * UNIT), total: '0' },
      // Marked at 31c: -$0.90 unrealized on the inherited position.
      { time: '2026-10-06T11:00:30.000Z', net: String(10 * UNIT), total: String(-90 * CENT) },
      // Sold at 35c: -$0.50 realized and $0.01 of fees, flat.
      { time: '2026-10-06T11:02:00.000Z', net: '0', total: String(-51 * CENT) },
    ]);
  });

  it('a window reaching back before the session started begins at its start', async () => {
    await session('old', '2026-10-06T10:00:00Z');
    await post('old', { fills: [{ source: 'VENUE', listingId: 500, clientOidCounter: 1, cumQtyAfter: 10 * UNIT,
      side: 0, fillQty: 10 * UNIT, fillPrice: 40 * CENT, fee: 0, eventTimeNs: 1, netQuantityAfter: 10 * UNIT,
      totalCostAfter: 400 * CENT, realizedPnlAfter: 0, feesAfter: 0, positionVersion: 1 }],
      marks: [{ listingId: 500, tsMs: Date.parse('2026-10-06T10:30:00Z'), bid: 30 * CENT, ask: 32 * CENT, lastTrade: 0 }] },
      '2026-10-06T10:01:00Z');
    await client.query(`UPDATE strategy.session SET status = 'STOPPED' WHERE session_id = 'old'`);
    await session('new', '2026-10-06T11:00:00Z');

    const series = await sessionSeries(client, 'new', new Date('2026-10-06T09:00:00Z'), new Date('2026-10-06T11:05:00Z'));

    const times = series.map(r => r.snapshot_time).sort();
    expect(times[0]).toBe('2026-10-06T11:00:00.000Z');
    // Opens holding the inherited 10, valued at the mark the old session left.
    expect(series.find(r => r.snapshot_time === times[0])?.total_pnl).toBe(String(-90 * CENT));
  });
});
