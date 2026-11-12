import { Pool, PoolClient } from 'pg';
import { connectExclusive, LOCK_TIMEOUT_MS, release } from './ledger-db';
import { insertAccruals, latestAccruals } from '../lambda/rewards/accruals';
import { loadRewards } from '../lambda/endpoints/pnl-state';
import { summarize } from '../lambda/endpoints/pnl-summary';

const url = process.env.LEDGER_TEST_DB;
const describeDb = url ? describe : describe.skip;
const DOLLAR = 1_000_000_000;
const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-11-11T05:00:00Z');

// A paper session (paper-1) on Kalshi listings 500 (YES) and 501 (NO) of one market, a live session (live-1) on 500,
// and listing 502 that no session leases.
describeDb('Estimated venue rewards from paper sessions, against Postgres', () => {
  let pool: Pool;
  let client: PoolClient;
  const now = new Date(T0 + 30 * HOUR);

  beforeAll(async () => {
    ({ pool, client } = await connectExclusive(url as string));
  }, LOCK_TIMEOUT_MS);

  afterAll(async () => {
    await release(pool, client);
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE ledger.reward_accrual, ledger.fill, ledger.position, ledger.order, ledger.mark,
      strategy.session_listing, strategy.session, strategy.strategy, sm.listing, sm.security, sm.exchange
      RESTART IDENTITY CASCADE`);
    await client.query(`INSERT INTO sm.exchange (exchange_id, exchange_name, region, exchange_code)
      VALUES (1, 'K', 'us-east-1', 'KALSHI')`);
    await client.query(`INSERT INTO sm.security (security_id, symbol, type) VALUES (1, 'Y', 4), (2, 'N', 4), (3, 'O', 4)`);
    await client.query(`INSERT INTO sm.listing (listing_id, exchange_id, security_id, exchange_security_id,
      exchange_security_symbol) VALUES (500, 1, 1, 'KX-A', 'KX-A'), (501, 1, 2, 'KX-A:no', 'KX-A-NO'),
      (502, 1, 3, 'KX-B', 'KX-B')`);
    await client.query(`INSERT INTO strategy.strategy (name) VALUES ('rt-maker')`);
    for (const [id, mode] of [['paper-1', 'paper'], ['live-1', 'live']]) {
      await client.query(`INSERT INTO strategy.session (session_id, strategy_id, status, mode, config, started_at)
        VALUES ($1, 1, 'RUNNING', $2, '{}', $3)`, [id, mode, new Date(T0)]);
    }
    await client.query(`INSERT INTO strategy.session_listing VALUES ('paper-1', 1, 'paper', 500, true),
      ('paper-1', 1, 'paper', 501, true), ('live-1', 1, 'live', 500, true)`);
  });

  const accrual = (fields: Record<string, unknown> = {}) => ({
    listingId: 500, venueMarket: 'KX-A', venueProgramId: 'k1', program: 'LIQUIDITY',
    periodStartMs: T0, periodEndMs: T0 + 24 * HOUR,
    asOfMs: T0 + HOUR, gross: String(2 * DOLLAR), marketGross: String(2 * DOLLAR),
    marketPaid: String(2 * DOLLAR), countingNanos: '3600000000000', oneSidedNanos: '0', depthUnknownNanos: '0',
    noDataNanos: '0', gaps: 0, ...fields,
  });

  it('stores a snapshot once, however often it is posted', async () => {
    expect(await insertAccruals(client, 'paper-1', [accrual()])).toEqual({ inserted: 1, skipped: 0 });
    expect(await insertAccruals(client, 'paper-1', [accrual()])).toEqual({ inserted: 0, skipped: 1 });
  });

  it("skips rows that aren't the session's to post, without failing the post", async () => {
    const result = await insertAccruals(client, 'paper-1', [
      accrual(),
      accrual({ listingId: 502, venueMarket: 'KX-B' }),
      accrual({ gross: '-5' }),
      accrual({ program: 'VOLUME' }),
      'not an accrual',
    ]);
    expect(result).toEqual({ inserted: 1, skipped: 4 });
    expect((await insertAccruals(client, 'live-1', [accrual()])).inserted).toBe(0);
    expect((await insertAccruals(client, 'nobody', [accrual()])).inserted).toBe(0);
  });

  it('reads each listing and program at its latest snapshot', async () => {
    await insertAccruals(client, 'paper-1', [
      accrual(),
      accrual({ asOfMs: T0 + 25 * HOUR, gross: String(5 * DOLLAR) }),
      accrual({ listingId: 501, gross: String(DOLLAR) }),
    ]);
    const latest = await latestAccruals(client, { sessionId: 'paper-1' });
    expect(latest.map(a => [a.listingId, a.gross, a.closed])).toEqual([
      [500, String(5 * DOLLAR), true],
      [501, String(DOLLAR), false],
    ]);
  });

  it("books what accrued between a session's snapshots into paper rewards, as estimates", async () => {
    await insertAccruals(client, 'paper-1', [
      accrual(),
      accrual({ asOfMs: T0 + 2 * HOUR, gross: String(3 * DOLLAR) }),
      accrual({ asOfMs: T0 + 3 * HOUR, gross: String(3 * DOLLAR) }),
    ]);
    const rows = await loadRewards(client, 'paper', { strategyId: 1, firm: false }, now);
    expect(rows.map(r => [r.amount, r.estimated, r.source])).toEqual([
      [BigInt(2 * DOLLAR), true, 'ESTIMATE'],
      [BigInt(DOLLAR), true, 'ESTIMATE'],
    ]);
    expect(await loadRewards(client, 'live', { strategyId: 1, firm: false }, now)).toEqual([]);
  });

  it('shows the estimate on the session and in the strategy summary, outside sessions', async () => {
    // Both of the market's listings carry the market's figure: paid counts it once.
    await insertAccruals(client, 'paper-1', [
      accrual({ asOfMs: T0 + 25 * HOUR, gross: String(3 * DOLLAR),
        marketGross: String(4 * DOLLAR), marketPaid: String(4 * DOLLAR) }),
      accrual({ listingId: 501, asOfMs: T0 + 25 * HOUR, gross: String(DOLLAR),
        marketGross: String(4 * DOLLAR), marketPaid: String(4 * DOLLAR) }),
    ]);
    const session = await summarize(client, { sessionId: 'paper-1' }, now) as any;
    expect(session.rewards.estimatedGross).toBe(String(4 * DOLLAR));
    expect(session.rewards.estimatedPaid).toBe(String(4 * DOLLAR));
    expect(session.rewards.programs).toHaveLength(2);

    const strategy = await summarize(client, { strategyId: '1', mode: 'paper' }, now) as any;
    expect(strategy.totals.rewards).toBe(String(4 * DOLLAR));
    expect(strategy.totals.outsideSessions.rewards).toBe(String(4 * DOLLAR));

    const totals = await summarize(client, { sessionIds: 'paper-1,live-1' }, now) as any;
    expect(totals.map((t: any) => t.rewardsEstimated)).toEqual([String(4 * DOLLAR), '0']);
  });
});
